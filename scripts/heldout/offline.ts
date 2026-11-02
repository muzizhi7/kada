import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { setTimeout } from "node:timers/promises";
import type { ModelRef } from "../../src/config.js";

/** Free plumbing test only. Never used as a task-quality observation. */
export function offlineModels(ref: ModelRef) {
  const provider = fauxProvider({ provider: ref.provider, models: [{ id: ref.modelId }] });
  provider.setResponses(Array.from({ length: 100 }, () => async (context: TranscriptContext) => {
    const results = context.messages.filter(message => message.role === "toolResult");
    if (!results.some(result => result.toolName === "read" && !result.isError)) return fauxAssistantMessage(fauxToolCall("read", { path: "TASK.md" }), { stopReason: "toolUse" });
    if (!results.some(result => result.toolName === "bash" && !result.isError)) return fauxAssistantMessage(fauxToolCall("bash", {
      command: "python3 - <<'PY'\nfrom pathlib import Path\np=Path('deliverables');p.mkdir(exist_ok=True)\ncount=Path('action-count.txt')\nif not count.exists():count.write_text('once\\n')\n(p/'ready.txt').write_text('ok')\nPY",
    }), { stopReason: "toolUse" });
    // Leaves a deterministic recovery boundary in the free test, not the paid tasks.
    await setTimeout(350);
    const proof = results.findLast(result => result.toolName === "task_verify" && !result.isError);
    if (!proof) return fauxAssistantMessage(fauxToolCall("task_verify", {
      command: "python3 - <<'PY'\nfrom pathlib import Path\nassert Path('deliverables/ready.txt').read_text()=='ok'\nassert Path('action-count.txt').read_text()=='once\\n'\nPY",
      inputs: ["action-count.txt"], outputs: ["deliverables/ready.txt"],
    }), { stopReason: "toolUse" });
    const receipt = JSON.parse(proof.content.filter(block => block.type === "text").map(block => block.text).join("\n")) as { id: string };
    return fauxAssistantMessage(fauxToolCall("task_submit", { summary: "One append and the actual result verified.", artifacts: ["deliverables/ready.txt"], criteria: [{ id: 1, status: "passed", evidence: "Pi bash checked actual output and append count.", proofIds: [receipt.id] }] }), { stopReason: "toolUse" });
  }));
  const models = createModels(); models.setProvider(provider.provider); return models;
}
