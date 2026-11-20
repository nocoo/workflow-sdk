#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "google-antigravity>=0.1.24",
#   "pydantic>=2.0",
# ]
# ///
"""Stdio NDJSON bridge exposing google-antigravity Python SDK to @nocoo/workflow-sdk."""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from typing import Any

from pydantic import BaseModel, Field, create_model


def _schema_to_annotation(node: dict[str, Any], name_hint: str) -> Any:
    if not isinstance(node, dict):
        return Any
    if "anyOf" in node:
        variants = tuple(_schema_to_annotation(v, f"{name_hint}_{idx}") for idx, v in enumerate(node["anyOf"]))
        return Any if not variants else variants[0]
    typ = node.get("type")
    if typ == "string":
        return str
    if typ == "integer":
        return int
    if typ == "number":
        return float
    if typ == "boolean":
        return bool
    if typ == "array":
        item_type = _schema_to_annotation(node.get("items") or {}, f"{name_hint}_Item")
        return list[item_type]  # type: ignore[valid-type]
    if typ == "object":
        props = node.get("properties") or {}
        if not props:
            return dict[str, Any]
        required = set(node.get("required") or [])
        fields: dict[str, Any] = {}
        for key, prop_schema in props.items():
            ann = _schema_to_annotation(prop_schema, f"{name_hint}_{key}")
            desc = prop_schema.get("description") if isinstance(prop_schema, dict) else None
            if key in required:
                fields[key] = (ann, Field(description=desc) if desc else ...)
            else:
                fields[key] = (ann | None, Field(default=None, description=desc))
        return create_model(name_hint, **fields)
    return Any


def _json_schema_to_pydantic(schema: dict[str, Any] | None) -> type[BaseModel] | None:
    if not schema:
        return None
    model = _schema_to_annotation(schema, "DynamicResponseModel")
    if isinstance(model, type) and issubclass(model, BaseModel):
        return model
    return None


class StdioBridge:
    """Bidirectional NDJSON bridge over stdin/stdout."""

    def __init__(self) -> None:
        self._agent: Any = None
        self._tmp_dir: tempfile.TemporaryDirectory[str] | None = None
        self._pending_rpc: dict[int, asyncio.Future[Any]] = {}
        self._next_rpc_id = 10_000_000
        self._write_lock = asyncio.Lock()

    async def _send(self, payload: dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        async with self._write_lock:
            sys.stdout.write(line)
            sys.stdout.flush()

    async def _call_host_tool(self, name: str, args: dict[str, Any]) -> Any:
        self._next_rpc_id += 1
        req_id = self._next_rpc_id
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[Any] = loop.create_future()
        self._pending_rpc[req_id] = fut
        await self._send({"id": req_id, "method": "tool_call", "params": {"name": name, "args": args}})
        return await fut

    def _build_proxy_tools(self, specs: list[dict[str, Any]]) -> list[Any]:
        proxies: list[Any] = []
        for spec in specs:
            name = str(spec["name"])
            desc = str(spec.get("description") or name)

            async def _proxy(payload_json: str = "{}", _name: str = name) -> str:
                parsed = json.loads(payload_json) if isinstance(payload_json, str) else payload_json
                result = await self._call_host_tool(_name, parsed if isinstance(parsed, dict) else {})
                return json.dumps(result, ensure_ascii=False)

            _proxy.__name__ = name
            _proxy.__doc__ = f"{desc} Pass arguments as a JSON string in payload_json."
            proxies.append(_proxy)
        return proxies

    async def handle_init(self, params: dict[str, Any]) -> dict[str, Any]:
        from google.antigravity import (
            Agent,
            BuiltinTools,
            CapabilitiesConfig,
            LocalAgentConfig,
            LocalOpenAIAgentConfig,
        )
        from google.antigravity.hooks import policy

        save_dir = params.get("saveDir")
        if not save_dir:
            self._tmp_dir = tempfile.TemporaryDirectory(prefix="agy_ts_bridge_")
            save_dir = self._tmp_dir.name

        cap_raw = params.get("capabilities") or {}
        alias_map = {
            "read_file": "view_file",
            "list_dir": "list_directory",
            "write_file": "create_file",
        }
        enabled_tools = []
        for raw_tool in cap_raw.get("enabledTools") or []:
            normalized = alias_map.get(str(raw_tool), str(raw_tool))
            enabled_tools.append(BuiltinTools(normalized))
        capabilities = CapabilitiesConfig(
            enabled_tools=enabled_tools or None,
            enable_subagents=bool(cap_raw.get("enableSubagents", False)),
        )

        policies_raw = params.get("policies") or []
        policies_list = []
        for rule in policies_raw:
            eff = rule.get("effect")
            if eff == "allow_all":
                policies_list.append(policy.allow_all())
            elif eff == "deny_all":
                policies_list.append(policy.deny_all())
            elif eff == "allow" and rule.get("toolName"):
                policies_list.append(policy.allow(str(rule["toolName"])))
        if not policies_list:
            policies_list = [policy.allow_all()]

        env = dict(params.get("env") or {})
        if params.get("apiKey") and "OPENAI_API_KEY" not in env and params.get("kind") == "openai":
            env["OPENAI_API_KEY"] = str(params["apiKey"])

        tools = self._build_proxy_tools(params.get("tools") or [])

        common_kwargs: dict[str, Any] = {
            "model": params["model"],
            "env": env,
            "system_instructions": params.get("systemInstructions"),
            "capabilities": capabilities,
            "policies": policies_list,
            "tools": tools or None,
            "response_schema": _json_schema_to_pydantic(params.get("responseSchema")),
            "save_dir": save_dir,
            "workspaces": params.get("workspaces") or None,
            "conversation_id": params.get("conversationId"),
        }
        if params.get("kind") == "local":
            config = LocalAgentConfig(
                vertex=bool(params.get("vertex", False)),
                project=params.get("project"),
                location=params.get("location"),
                api_key=params.get("apiKey"),
                **common_kwargs,
            )
        else:
            config = LocalOpenAIAgentConfig(
                base_url=params["baseUrl"],
                **common_kwargs,
            )

        self._agent = Agent(config)
        await self._agent.__aenter__()
        return {"ok": True}

    async def handle_chat(self, params: dict[str, Any]) -> dict[str, Any]:
        if self._agent is None:
            raise RuntimeError("Agent not initialized")
        response = await self._agent.chat(str(params["prompt"]))
        text = (await response.text()) or ""
        structured = await response.structured_output()
        if structured is None and text.strip().startswith("{"):
            try:
                structured = json.loads(text)
            except Exception:
                pass
        usage = response.usage_metadata
        if isinstance(usage, dict):
            usage_out = {
                "promptTokenCount": int(usage.get("prompt_token_count") or 0),
                "candidatesTokenCount": int(usage.get("candidates_token_count") or 0),
                "thoughtsTokenCount": int(usage.get("thoughts_token_count") or 0),
                "totalTokenCount": int(usage.get("total_token_count") or 0),
            }
        else:
            usage_out = {
                "promptTokenCount": int(getattr(usage, "prompt_token_count", 0) or 0),
                "candidatesTokenCount": int(getattr(usage, "candidates_token_count", 0) or 0),
                "thoughtsTokenCount": int(getattr(usage, "thoughts_token_count", 0) or 0),
                "totalTokenCount": int(getattr(usage, "total_token_count", 0) or 0),
            }
        return {"text": text or "", "structured": structured, "usageMetadata": usage_out}

    async def handle_close(self) -> dict[str, Any]:
        if self._agent is not None:
            await self._agent.__aexit__(None, None, None)
            self._agent = None
        if self._tmp_dir is not None:
            self._tmp_dir.cleanup()
            self._tmp_dir = None
        return {"ok": True}

    async def _dispatch_request(self, msg: dict[str, Any]) -> None:
        req_id = msg["id"]
        method = msg.get("method")
        params = msg.get("params") or {}
        try:
            if method == "init":
                res = await self.handle_init(params)
            elif method == "chat":
                res = await self.handle_chat(params)
            elif method == "close":
                res = await self.handle_close()
            else:
                raise RuntimeError(f"Unknown method: {method}")
            await self._send({"id": req_id, "result": res})
        except Exception as exc:
            await self._send({"id": req_id, "error": {"message": str(exc)}})

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: protocol, sys.stdin)

        tasks: set[asyncio.Task[None]] = set()
        while True:
            raw = await reader.readline()
            if not raw:
                break
            line = raw.decode("utf-8").strip()
            if not line:
                continue
            msg = json.loads(line)
            if "method" in msg:
                task = asyncio.create_task(self._dispatch_request(msg))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
            elif "id" in msg and msg["id"] in self._pending_rpc:
                fut = self._pending_rpc.pop(msg["id"])
                if not fut.done():
                    if "error" in msg:
                        fut.set_exception(RuntimeError(msg["error"].get("message", "Tool error")))
                    else:
                        fut.set_result(msg.get("result"))
        await self.handle_close()


if __name__ == "__main__":
    asyncio.run(StdioBridge().run())
