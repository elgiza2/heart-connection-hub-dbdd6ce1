/**
 * @doc Server-only tool layer for the Dev Agent.
 *
 * Everything the agent can physically do lives here: booting a VM, scaffolding
 * a real React 18 + Vite + TypeScript + Tailwind project, editing files,
 * running shell commands, building, committing to the project's Git repo,
 * importing a GitHub repo, wiring Supabase env vars and deploying.
 *
 * The agent loop only chooses which of these to call — it never talks to the
 * Freestyle API directly.
 */
import { FreestyleClient, type ExecResult } from "./freestyle";

const WORKDIR = "/app";

export interface ToolCall {
  tool: string;
  path?: string;
  content?: string;
  command?: string;
  message?: string;
  [key: string]: unknown;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

function clip(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated, ${text.length - max} more chars)`;
}

/** A live project checkout inside one Freestyle VM. */
export class DevWorkspace {
  readonly client: FreestyleClient;
  readonly vmId: string;

  constructor(client: FreestyleClient, vmId: string) {
    this.client = client;
    this.vmId = vmId;
  }

  static async boot(
    client: FreestyleClient,
    existingVmId?: string | null,
    existingPreviewUrl?: string | null,
  ): Promise<{ ws: DevWorkspace; vmId: string; previewUrl: string | null; reused: boolean }> {
    if (existingVmId) {
      // Reuse the existing VM whenever it still exists — creating a fresh VM
      // per slice used to wipe the workspace and force a full re-scaffold.
      try {
        const info = await client.getVm(existingVmId).catch(() => null);
        const state = String(info?.state ?? "").toLowerCase();
        if (info && state !== "deleted" && state !== "deleting") {
          if (state !== "running") await client.startVm(existingVmId);
          // Older VMs may have a root-owned workdir from the fs API.
          await client.exec(existingVmId, `sudo mkdir -p ${WORKDIR} && sudo chown -R $(id -un):$(id -gn) ${WORKDIR}`, 30_000).catch(() => null);
          return {
            ws: new DevWorkspace(client, existingVmId),
            vmId: existingVmId,
            previewUrl: existingPreviewUrl ?? null,
            reused: true,
          };
        }
      } catch {
        /* VM was reaped — fall through and create a fresh one */
      }
    }
    const vm = await client.createVm({ idleTimeoutSeconds: 1800 });
    const ws = new DevWorkspace(client, vm.id);
    await client.waitForRunning(vm.id);
    // NOTE: ws.bash cds into WORKDIR first, which fails before the dir exists.
    await client.exec(vm.id, `sudo mkdir -p ${WORKDIR} && sudo chown -R $(id -un):$(id -gn) ${WORKDIR}`, 30_000);
    // v5 VMs have no implicit domain — route a style.dev name to port 3000.
    const previewDomain = await client.exposePort(vm.id, 3000);
    return {
      ws,
      vmId: vm.id,
      previewUrl: `https://${previewDomain}`,
      reused: false,
    };
  }

  bash(command: string, timeoutMs = 240_000): Promise<ExecResult> {
    return this.client.exec(this.vmId, `cd ${WORKDIR} && ${command}`, timeoutMs);
  }

  /** True when the workdir already holds a project. */
  async hasProject(): Promise<boolean> {
    const res = await this.bash("test -f package.json && echo yes || echo no", 30_000);
    return res.stdout.includes("yes");
  }

  /**
   * Scaffolds a real Vite + React 18 + TS + Tailwind + router app — not an
   * HTML page. Everything is installed inside the VM, so the agent works with
   * a genuine node_modules and a genuine build.
   */
  async scaffold(): Promise<ExecResult> {
    // exec-await caps each call at ~290s, so scaffold runs in stages.
    const stages: Array<{ cmd: string; timeout: number }> = [
      { cmd: "printf '%s' '{\"name\":\"app\",\"private\":true,\"version\":\"0.0.0\"}' > package.json && npm create vite@latest . -- --template react-ts --yes && npm pkg set dependencies.react=^18.3.1 dependencies.react-dom=^18.3.1", timeout: 240_000 },
      { cmd: "npm install && npm install react-router-dom lucide-react clsx", timeout: 280_000 },
      { cmd: "npm install -D tailwindcss@^3.4.17 postcss autoprefixer && npx tailwindcss init -p", timeout: 280_000 },
      {
        cmd: [
          `printf '%s\\n' "/** @type {import('tailwindcss').Config} */" "export default { content: ['./index.html','./src/**/*.{js,ts,jsx,tsx}'], theme: { extend: {} }, plugins: [] }" > tailwind.config.js`,
          `printf '%s\\n' "@tailwind base;" "@tailwind components;" "@tailwind utilities;" > src/index.css`,
        ].join(" && "),
        timeout: 30_000,
      },
    ];
    let last: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
    for (const stage of stages) {
      last = await this.bash(stage.cmd, stage.timeout);
      if (last.exitCode !== 0) return last;
    }
    return last;
  }

  /** Imports a public GitHub repository into the workdir. */
  async importGithub(repoUrl: string, branch?: string): Promise<ExecResult> {
    const b = branch ? `-b ${branch}` : "";
    return this.bash(
      `rm -rf ./* ./.[!.]* 2>/dev/null; git clone --depth 1 ${b} ${repoUrl} . && (npm install || true)`,
      480_000,
    );
  }

  /** Starts the Vite dev server on port 3000 (the VM's public preview port). */
  async startDevServer(): Promise<void> {
    await this.bash(
      // Bracket trick: pkill -f 'vite' would match this very shell's cmdline
      // and kill itself before vite ever starts.
      "pkill -f '[v]ite' || true; (nohup npx vite --host 0.0.0.0 --port 3000 > /tmp/dev.log 2>&1 &) ; sleep 3; true",
      60_000,
    );
  }

  /** True when the dev server is responding on the public preview port. */
  async isDevServerReady(retries = 8): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      const res = await this.bash(
        "curl -sf -o /dev/null http://localhost:3000/ && echo ready || echo not_ready",
        10_000,
      );
      if (res.stdout.includes("ready")) return true;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  }

  /** Reads every file under dist/ into a deployable map. */
  async collectDistFiles(): Promise<Record<string, { content: string; encoding?: string }>> {
    const files: Record<string, { content: string; encoding?: string }> = {};
    const queue: string[] = ["dist"];
    while (queue.length) {
      const dir = queue.shift()!;
      const listing = await this.client.listDir(this.vmId, `${WORKDIR}/${dir}`);
      for (const item of listing) {
        const fullPath = `${dir}/${item.name}`;
        if (item.kind === "directory") {
          queue.push(fullPath);
        } else {
          const content = await this.readFile(fullPath);
          files[fullPath.replace(/^dist\//, "")] = { content };
        }
      }
    }
    return files;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const cleanPath = path.replace(/^\/+/, "");
    if (!cleanPath || cleanPath.split("/").includes("..")) {
      throw new Error("Invalid project file path");
    }
    const dir = cleanPath.split("/").slice(0, -1).join("/");
    if (dir) await this.bash(`mkdir -p ${JSON.stringify(dir)}`, 20_000);
    const absolutePath = `${WORKDIR}/${cleanPath}`;
    await this.client.writeFile(this.vmId, absolutePath, content);
    const saved = await this.client.readFile(this.vmId, absolutePath);
    if (saved !== content) throw new Error(`File verification failed: ${cleanPath}`);
  }

  async readFile(path: string): Promise<string> {
    return this.client.readFile(this.vmId, `${WORKDIR}/${path.replace(/^\/+/, "")}`);
  }

  /** Text project snapshot used by the private GitHub persistence layer. */
  async projectFiles(): Promise<Array<{ path: string; content: string }>> {
    const listed = await this.bash(
      "find . -type f -size -2M -not -path './node_modules/*' -not -path './.git/*' -not -path './dist/*' -not -name '.env' -print | sed 's#^./##' | sort | head -400",
      45_000,
    );
    const paths = listed.stdout.split("\n").map((path) => path.trim()).filter(Boolean);
    const files: Array<{ path: string; content: string }> = [];
    for (const path of paths) {
      const content = await this.readFile(path);
      if (content.includes("\u0000")) continue;
      files.push({ path, content });
    }
    return files;
  }

  /** Compact file tree the model can reason about, ignoring noise. */
  async tree(depth = 3): Promise<string> {
    const res = await this.bash(
      `find . -maxdepth ${depth} -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -160`,
      45_000,
    );
    return res.stdout.trim();
  }

  /** Type-checks + builds. This is the verifier's ground truth. */
  async build(): Promise<ExecResult> {
    return this.bash("npm run build 2>&1 | tail -60", 480_000);
  }

  /** Writes Supabase credentials the generated app can use. */
  async writeSupabaseEnv(url: string, anonKey: string): Promise<void> {
    await this.writeFile(".env", `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${anonKey}\n`);
  }

  /**
   * Serves the built `dist/` on port 8080 behind its own public style.dev
   * name — this is the published site. Persistence of the source itself is
   * handled by the private GitHub storage layer.
   */
  async publishDist(subdomain?: string): Promise<string> {
    const res = await this.bash("test -d dist && ls dist/index.html", 20_000);
    if (res.exitCode !== 0) throw new Error("No dist/ output to publish — run a build first");
    await this.bash(
      "pkill -f 'http-server .*8080' || true; nohup npx --yes http-server dist -p 8080 -a 0.0.0.0 --silent > /tmp/publish.log 2>&1 & sleep 3; true",
      120_000,
    );
    for (let i = 0; i < 8; i++) {
      const probe = await this.bash(
        "curl -sf -o /dev/null http://localhost:8080/ && echo ready || echo not_ready",
        10_000,
      );
      if (probe.stdout.includes("ready")) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const domain = await this.client.exposePort(this.vmId, 8080, subdomain);
    return `https://${domain}`;
  }
}

/** Executes one model-chosen tool call against the workspace. */
export async function runTool(ws: DevWorkspace, call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.tool) {
      case "write_file": {
        if (!call.path) return { ok: false, output: "write_file needs a path" };
        await ws.writeFile(call.path, call.content ?? "");
        return { ok: true, output: `wrote ${call.path} (${(call.content ?? "").length} chars)` };
      }
      case "read_file": {
        if (!call.path) return { ok: false, output: "read_file needs a path" };
        return { ok: true, output: clip(await ws.readFile(call.path), 6000) };
      }
      case "delete_file": {
        if (!call.path) return { ok: false, output: "delete_file needs a path" };
        await ws.bash(`rm -rf ${JSON.stringify(call.path)}`, 30_000);
        return { ok: true, output: `deleted ${call.path}` };
      }
      case "list_dir": {
        const res = await ws.bash(
          `ls -1 ${JSON.stringify(call.path || ".")} | head -100`,
          30_000,
        );
        return { ok: res.exitCode === 0, output: clip(res.stdout || res.stderr) };
      }
      case "bash": {
        if (!call.command) return { ok: false, output: "bash needs a command" };
        const res = await ws.bash(call.command);
        return {
          ok: res.exitCode === 0,
          output: clip(`exit=${res.exitCode}\n${res.stdout}\n${res.stderr}`.trim()),
        };
      }
      case "build": {
        const res = await ws.build();
        return {
          ok: res.exitCode === 0,
          output: clip(`exit=${res.exitCode}\n${res.stdout}\n${res.stderr}`.trim()),
        };
      }
      default:
        return { ok: false, output: `Unknown tool: ${call.tool}` };
    }
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

/** Free screenshot service — no key needed, used for the deploy card. */
export function screenshotUrl(siteUrl: string): string {
  return `https://s.wordpress.com/mshots/v1/${encodeURIComponent(siteUrl)}?w=1200&h=800`;
}
