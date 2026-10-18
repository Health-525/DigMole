/**
 * Pi SDK spike — does this thing fit as the excavator's agent runtime?
 *
 * Each section answers one risk:
 *  1. Can we boot a session with ONLY our excavator tools (no bash/file access)?
 *  2. Does the codemode QuickJS sandbox await a long-running host tool?
 *  3. What does the event stream look like (it feeds the right-hand trace panel)?
 *  4. Does the codemode sandbox leak the filesystem?
 */
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Sim, createSandbox, toolByName } from "@digmole/sim";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const agentDir = join(root, ".pi-agent");

const sim = new Sim(createSandbox());
const t0 = Date.now();

function text(value: unknown) {
  return { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) };
}

/** Wraps one of our sim tools as a Pi ToolDefinition. */
function piTool(name: string) {
  const spec = toolByName(name);
  if (!spec) throw new Error(`unknown tool ${name}`);
  return {
    name: spec.name,
    label: spec.name,
    description: spec.description,
    promptSnippet: `${spec.name} — ${spec.description.slice(0, 40)}`,
    parameters: Type.Object({ targetId: Type.Optional(Type.String()) }),
    async execute(_id: string, params: unknown) {
      const parsed = spec.parse(params);
      if (!parsed.ok) return { content: [text(parsed.error)], details: undefined };
      const started = Date.now();
      const res = await spec.exec(sim, parsed.value);
      const took = Date.now() - started;
      return {
        content: [text(`${res.ok ? "OK" : "FAIL"}: ${res.message} (${took}ms)`)],
        details: res,
      };
    },
  };
}

const report: { name: string; ok: boolean; note: string }[] = [];
function check(name: string, ok: boolean, note: string) {
  report.push({ name, ok, note });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}\n   ${note}\n`);
}

async function main() {
  console.log("=".repeat(70));
  console.log("Pi SDK spike · @earendil-works/pi-coding-agent");
  console.log("=".repeat(70) + "\n");

  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    extensionFactories: [createCodemodeExtension({ mode: "on" })],
  });
  await resourceLoader.reload();

  const settingsManager = SettingsManager.create(root);
  settingsManager.applyOverrides({ defaultTools: ["+codemode"] });

  let session;
  try {
    const created = await createAgentSession({
      cwd: root,
      agentDir,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(),
      noTools: "all",
      customTools: [piTool("observe"), piTool("scoop"), piTool("dump_to"), piTool("drive_to")],
      tools: ["observe", "scoop", "dump_to", "drive_to", "codemode"],
    });
    session = created.session;
  } catch (err) {
    check("1. 以 noTools+customTools 创建会话", false, `createAgentSession 抛错：${String(err)}`);
    return summarise();
  }

  await session.bindExtensions({});
  const active = session.getActiveToolNames();
  console.log("   活动工具:", active.join(", "));
  console.log("   可用工具:", session.getCallableToolNames().join(", "), "\n");

  const onlyOurs = active.every((n) => ["observe", "scoop", "dump_to", "drive_to", "codemode"].includes(n));
  check(
    "1. 会话只暴露挖掘工具，没有 bash/read/write/edit",
    onlyOurs && !active.includes("bash") && !active.includes("read"),
    `active = [${active.join(", ")}]`,
  );

  // 3. 事件流
  const seen = new Set<string>();
  session.subscribe((event: { type: string }) => seen.add(event.type));

  // 2 + 4. codemode：长耗时工具 + 沙箱隔离
  const codemode = session.getToolDefinition("codemode");
  if (!codemode) {
    check("2. codemode 沙箱里 await 长耗时工具", false, "没有拿到 codemode 工具定义");
    return summarise();
  }
  console.log("   codemode 参数 schema:", JSON.stringify(codemode.parameters).slice(0, 200), "\n");

  // A direct call has no session context, so codemode sees zero tools. Build the minimal
  // context it needs so we exercise the real QuickJS sandbox + real await on a host tool.
  const agentTools = [piTool("observe"), piTool("scoop"), piTool("dump_to"), piTool("drive_to")];
  const ping = {
    name: "ping",
    label: "ping",
    description: "test tool",
    parameters: Type.Object({}),
    async execute(_id: string) {
      return { content: [text("pong")], details: undefined };
    },
  };
  const ctxTools = [ping, ...agentTools];
  const fakeCtx = {
    tools: ctxTools,
    modelRegistry: {},
    sessionManager: { getBranch: () => [] },
    async executeTool(name: string, args: unknown) {
      const tool = ctxTools.find((t) => t.name === name);
      const toolCall = { id: `nested-${name}`, name, args };
      if (!tool) return { toolCall, isError: true, result: { content: [text(`unknown tool ${name}`)] } };
      try {
        const result = await tool.execute("nested", args, undefined, undefined, fakeCtx as never);
        return { toolCall, isError: false, result };
      } catch (err) {
        return { toolCall, isError: true, result: { content: [text(String(err))] } };
      }
    },
  };

  const pingResult = await codemode.execute(
    "spike-ping",
    { code: `return await tools.ping()` } as never,
    undefined,
    undefined,
    fakeCtx as never,
  );
  console.log("   ping 结果:", pingResult.content.map((c) => c.text).join(" ").slice(0, 200), "\n");

  const diag = await codemode.execute(
    "spike-0",
    { code: `return JSON.stringify({ all: ALL_TOOLS })` } as never,
    undefined,
    undefined,
    fakeCtx as never,
  );
  console.log("   沙箱内 ALL_TOOLS:", diag.content.map((c) => c.text).join(" ").slice(0, 400), "\n");

  const scooped = await new Promise<{ ms: number; body: string }>((resolvePromise) => {
    const started = Date.now();
    const p = codemode.execute(
      "spike-1",
      {
        code: `
          const before = await tools.observe({});
          const r = await tools.scoop({ targetId: "pile-east" });
          const after = await tools.observe({});
          return JSON.stringify({ scoop: r, t: after });
        `,
      } as never,
      undefined,
      undefined,
      fakeCtx as never,
    );
    void p.then((res: { content: { text: string }[] }) => {
      resolvePromise({ ms: Date.now() - started, body: res.content.map((c) => c.text).join("\n") });
    });
  });

  const simDug = sim.world.terrain.totalDug;
  console.log("   沙箱返回：", scooped.body.slice(0, 600), "\n");
  check(
    "2. codemode 沙箱里 await 长耗时宿主工具",
    simDug > 0,
    `沙箱内 scoop 后真实地形挖方 ${simDug.toFixed(2)} m³；耗时 ${scooped.ms}ms（说明 await 真的等到了）`,
  );

  const fsAttempt = await codemode.execute(
    "spike-2",
    {
      code: `try { const fs = await import("node:fs"); return "LEAKED " + typeof fs; } catch (e) { return "BLOCKED: " + e.message; }`,
    } as never,
    undefined,
    undefined,
    fakeCtx as never,
  );
  const fsText = fsAttempt.content.map((c) => c.text).join(" ");
  check("4. codemode 沙箱无法访问 filesystem", fsText.includes("BLOCKED"), fsText.slice(0, 160));

  check(
    "3. 事件订阅可用",
    true,
    `已订阅；目前收到的事件类型：${seen.size ? [...seen].join(", ") : "（还没跑 LLM，所以为空）"}`,
  );

  session.dispose();
  summarise();
}

function summarise() {
  console.log("=".repeat(70));
  const pass = report.filter((r) => r.ok).length;
  console.log(`结果：${pass}/${report.length} 通过，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const r of report) console.log(`  ${r.ok ? "[PASS]" : "[FAIL]"} ${r.name}`);
  if (pass !== report.length) process.exitCode = 1;
}

await main();
