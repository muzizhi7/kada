import { createInterface, clearLine, cursorTo } from "node:readline";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { Readable, Writable } from "node:stream";
import type { HarnessClient, TaskMeta, TaskStatus } from "./client.js";
import { errorText, SerialQueue } from "./util.js";
import { briefText, usageText, verificationText } from "./presentation.js";
import { isConfirmation } from "./preparation.js";

type Message = TaskStatus["messages"][number];
export type ChatEvent = { kind: "info" | "answer" | "error"; text: string };

function answer(message: Message): string | undefined {
  if (message.role !== "assistant" || message.content.some(b => b.type === "toolCall")) return;
  if (!["stop", "length"].includes(message.stopReason)) return;
  const text = message.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  return text.trim() ? text : undefined;
}
function answerKey(message: Message, text: string): string { return `${message.timestamp}:${text}`; }
const HELP = `直接输入目标：先澄清并确认交付标准和预算，确认后自主执行。\n\n/new [目标]       新建任务，原任务继续在后台运行\n/confirm          确认刚展示的任务说明与预算\n/run 目标         已有明确授权，沿用配置预算直接执行\n/tasks            列出最近的任务\n/attach 任务ID    接回已有任务与待确认说明\n/status           查看目标、预算、核验范围和进度\n/pause            暂停当前任务\n/resume           恢复；显式补充一份配置/已确认预算，不代替目标确认\n/cancel           取消当前任务\n/help             显示帮助\n/quit             退出聊天，后台任务继续运行`;

/** Conversation selection and delivery are independent of terminal rendering. */
export class ChatSession {
  taskId?: string;
  private printed = new Set<string>();
  private activity = "";
  private shownBrief?: { revision: number; digest: string };
  constructor(private client: HarnessClient, private emit: (event: ChatEvent) => void, private workspace?: string) {}
  private info(text: string): void { this.emit({ kind: "info", text }); }
  private select(id?: string): void { this.taskId = id; this.printed.clear(); this.activity = ""; this.shownBrief = undefined; }
  async attach(id: string): Promise<void> {
    const status = await this.client.request<TaskStatus>(`/v1/tasks/${id}`);
    this.select(id);
    this.info(`已接入任务 ${id}\n目标：${status.objective}\n输出目录：${status.workspace}`);
    if (!status.goal) {
      const answers = status.messages.map(m => ({ m, text: answer(m) })).filter(v => v.text !== undefined);
      for (const item of answers) this.printed.add(answerKey(item.m, item.text!));
      const last = answers.at(-1);
      if (last) this.emit({ kind: "answer", text: last.text! });
    }
    await this.poll();
  }
  /** false means exit the client; the daemon and tasks are left running. */
  async handle(line: string): Promise<boolean> {
    const text = line.trim();
    if (!text) return true;
    if (text.startsWith("/")) {
      const match = /^(\/\S+)(?:\s+([\s\S]*))?$/.exec(text);
      if (!match) throw new Error("未知命令，输入 /help 查看帮助。");
      const command = match[1], argument = match[2]?.trim();
      if (command === "/quit" || command === "/exit") return false;
      if (command === "/help") { this.info(HELP); return true; }
      if (command === "/confirm") { await this.confirm(); return true; }
      if (command === "/run") {
        if (!argument) throw new Error("用法：/run 已明确授权的目标（沿用当前配置预算）");
        this.select(); await this.send(argument, true); return true;
      }
      if (command === "/new") {
        this.select();
        this.info("已切换到新对话。原任务会继续在后台运行。");
        if (argument) await this.send(argument);
        return true;
      }
      if (command === "/attach") {
        if (!argument) throw new Error("用法：/attach 任务ID");
        await this.attach(argument);
        return true;
      }
      if (command === "/tasks") {
        const tasks = (await this.client.request<(TaskMeta & { status: string })[]>("/v1/tasks")).slice(0, 10);
        if (!tasks.length) this.info("还没有任务，直接输入目标即可开始。");
        else for (const task of tasks) {
          this.info(`${task.id}  [${task.status}]  ${task.objective.slice(0, 100).replace(/\s+/g, " ")}`);
        }
        return true;
      }
      if (["/status", "/pause", "/resume", "/cancel"].includes(command!)) {
        if (!this.taskId) throw new Error("还未选择任务。直接输入目标，或使用 /attach 任务ID。");
        if (command === "/status") {
          const status = await this.client.request<TaskStatus>(`/v1/tasks/${this.taskId}`);
          const goal = status.goal;
          this.info(`任务：${status.id}\n状态：${status.status === "completed" ? "已交付（核验范围见下）" : status.status}\n子 Agent：${status.activeWorkerCount} 个运行 / ${status.workerCount} 个累计\n输出目录：${status.workspace}\n${usageText(status)}${goal ? `\n目标修订：${goal.revision}\n计划${status.planPolicy === "advisory" ? "（辅助进度）" : "（历史交付约束）"}：${goal.plan.filter(s => s.status === "done").length}/${goal.plan.length}\n自动返工：${goal.reworks}${goal.reason ? `\n原因：${goal.reason}` : ""}${goal.question ? `\n待回答：${goal.question}` : ""}` : ""}\n${verificationText(status)}${goal?.brief ? `\n${briefText(status)}${goal.confirmation ? "\n该版本已确认；预算不会因普通消息或重复确认补充。" : ""}` : ""}`);
        } else {
          await this.client.request(`/v1/tasks/${this.taskId}/${command!.slice(1)}`, "POST", {});
          this.activity = "";
          this.info(command === "/pause" ? "任务已暂停。" : command === "/resume" ? "任务已恢复。" : "任务已取消；输入 /new 开始新任务。");
        }
        return true;
      }
      throw new Error("未知命令，输入 /help 查看帮助。");
    }
    if (this.taskId && this.shownBrief && isConfirmation(text)) await this.confirm();
    else if (!this.taskId && /^(?:直接执行|直接开始|按默认预算执行)[：:]/u.test(text)) await this.send(text, true);
    else await this.send(text);
    return true;
  }
  private async confirm(): Promise<void> {
    if (!this.taskId) throw new Error("还没有待确认的任务。");
    const status = await this.client.request<TaskStatus>(`/v1/tasks/${this.taskId}`);
    if (!this.shownBrief || this.shownBrief.digest !== status.briefDigest || this.shownBrief.revision !== status.goal?.brief?.revision) {
      await this.poll();
      throw new Error("请先查看当前版本的任务说明与预算，再回复确认开始。");
    }
    await this.client.request(`/v1/tasks/${this.taskId}/confirm`, "POST", this.shownBrief);
    this.activity = "";
    this.info(status.goal?.confirmation ? "该版本已确认；保留原预算与执行进度。" : "任务说明与预算已确认，Agent 将自主执行、验证和修正。");
  }
  private async send(message: string, confirmed = false): Promise<void> {
    if (!this.taskId) {
      const task = await this.client.request<TaskMeta>("/v1/tasks", "POST", { objective: message, workspace: this.workspace, confirmed });
      this.select(task.id);
      this.info(`任务：${task.id}\n输出目录：${task.workspace}\n${confirmed ? "沿用已有授权与配置预算直接执行。" : "先整理目标和交付标准，确认前只读取材料。"}费用上限 $${task.maxEstimatedCostUsd ?? 1}，配置时限 ${(task.deadlineAt - task.createdAt) / 60_000} 分钟。`);
    } else {
      await this.client.request(`/v1/tasks/${this.taskId}/messages`, "POST", { message, requestId: randomUUID() });
      this.info("消息已发送，Agent 会继续当前对话。");
    }
    this.activity = "";
  }
  async poll(): Promise<void> {
    const id = this.taskId;
    if (!id) return;
    const status = await this.client.request<TaskStatus>(`/v1/tasks/${id}`);
    if (this.taskId !== id) return;
    for (const message of status.goal ? [] : status.messages) {
      const text = answer(message);
      if (!text) continue;
      const key = answerKey(message, text);
      if (!this.printed.has(key)) {
        this.printed.add(key);
        this.emit({ kind: "answer", text });
      }
    }
    const goal = status.goal;
    if (["clarifying", "awaiting_confirmation"].includes(status.status) && goal?.brief) {
      const key = `brief:${goal.brief.revision}:${status.briefDigest}`;
      if (!this.printed.has(key)) {
        this.printed.add(key);
        this.emit({ kind: "answer", text: briefText(status) });
      }
      if (status.status === "awaiting_confirmation" && status.briefDigest) this.shownBrief = { revision: goal.brief.revision, digest: status.briefDigest };
      else this.shownBrief = undefined;
    }
    if (status.status === "completed" && goal?.candidate) {
      const key = `goal:${goal.revision}:${goal.candidate.id}`;
      if (!this.printed.has(key)) {
        this.printed.add(key);
        this.info(`已提交结果。\n${verificationText(status)}\n估算费用：$${status.budget.estimatedCostUsd.toFixed(4)}；累计 token：${status.budget.totalTokens}（含缓存读取 ${status.budget.cachedTokens}）。`);
        this.emit({ kind: "answer", text: goal.candidate.summary });
      }
    }
    const activity = `${status.status}:${status.workerCount}:${goal?.brief?.revision}:${goal?.reworks}:${goal?.reason}`;
    if (activity === this.activity) return;
    this.activity = activity;
    if (status.status === "running" || status.status === "pending") {
      this.info(status.preparation && !goal?.confirmation ? "正在整理目标、交付标准与预算…" : goal?.reworks ? `正在修正验收问题，第 ${goal.reworks} 次自动返工…` : status.workerCount ? `正在处理，已创建 ${status.workerCount} 个子 Agent…` : "正在处理…");
    } else if (status.status === "verifying") this.info(status.schemaVersion === 3 && !status.review ? "已提交结果，正在检查交付物…" : "已提交结果，正在检查交付物并独立评审…");
    else if (status.status === "completed" && !goal?.candidate) this.info(`已提交结果。\n${verificationText(status)}`);
    else if (status.status === "waiting_user") this.info(`需要补充信息：${goal?.question ?? goal?.reason}`);
    else if (["blocked", "needs_attention"].includes(status.status)) this.info(`任务已停止自动推进：${goal?.reason}\n可补充要求，或输入 /resume 重试。`);
    else if (status.status === "failed") this.emit({ kind: "error", text: `执行失败：${goal?.reason ?? (status.submission?.status === "unanswered" ? status.submission.reason : "未知原因")}。可以补充要求重试，或输入 /resume。` });
    else if (status.status === "budget_limited") this.info(`任务预算已耗尽：${goal?.reason ?? "达到时限"}。输入 /resume 可按配置补充一份任务预算后继续。`);
  }
}

export async function runChat(client: HarnessClient, options: {
  taskId?: string; workspace?: string; input?: Readable; output?: Writable; intervalMs?: number;
} = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const terminal = Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY);
  const rl = createInterface({ input, output, terminal, prompt: "你 > " });
  rl.pause();
  let closed = false;
  let exiting = false;
  let finished = false;
  let lastPollError = "";
  const queue = new SerialQueue();
  const render = (event: ChatEvent) => {
    if (finished) return;
    if (terminal) { clearLine(output, 0); cursorTo(output, 0); }
    output.write(event.kind === "answer" ? `\nAgent > ${event.text}\n\n` : `${event.kind === "error" ? "错误：" : ""}${event.text}\n`);
    if (terminal && !closed) rl.prompt(true);
  };
  const session = new ChatSession(client, render, options.workspace);
  output.write("Local Pi Harness · 终端聊天\n输入目标，先确认交付标准与预算，再自主执行。/help 查看命令，/quit 退出。\n\n");
  const end = new Promise<void>(resolve => rl.once("close", () => { closed = true; resolve(); }));
  rl.on("SIGINT", () => rl.close());
  let commandWork: Promise<unknown> = Promise.resolve();
  rl.on("line", line => {
    commandWork = queue.run(async () => {
      if (exiting) return;
      try {
        const keepGoing = await session.handle(line);
        if (!keepGoing) { exiting = true; rl.close(); return; }
      } catch (error) { render({ kind: "error", text: errorText(error) }); }
      if (!closed && terminal) { clearLine(output, 0); cursorTo(output, 0); rl.prompt(); }
    });
  });
  if (options.taskId) {
    try { await session.attach(options.taskId); }
    catch (error) { rl.close(); throw error; }
  }
  rl.resume();
  if (terminal && !closed) { clearLine(output, 0); cursorTo(output, 0); rl.prompt(); }
  const polling = (async () => {
    while (!closed) {
      try { await session.poll(); lastPollError = ""; }
      catch (error) {
        const message = errorText(error);
        if (message !== lastPollError) render({ kind: "error", text: `无法获取进度：${message}。任务仍保存在后台服务中。` });
        lastPollError = message;
      }
      await setTimeout(options.intervalMs ?? 750);
    }
  })();
  await end;
  await commandWork;
  await polling;
  finished = true;
  output.write(`已退出聊天。任务按当前状态保存在后台；已确认的执行继续，待确认任务不会开始执行。${session.taskId ? `重新运行 npm run chat，再输入 /attach ${session.taskId} 可继续。` : ""}\n`);
}
