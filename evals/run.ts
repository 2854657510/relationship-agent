import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { cases, type EvalCase, type ScriptStep } from "./cases.ts";
import { createTestPool } from "../server/src/db/client.ts";
import { runMigrations } from "../server/src/db/migrate.ts";
import { seedDatabase } from "../server/src/db/seed.ts";
import {
  answerQuestionnaire,
  decidePermission,
  startMessageRun,
} from "../server/src/agent-service.ts";
import { confirmAction, rejectAction } from "../server/src/action-service.ts";
import { runInsightForAction } from "../server/src/insight-agent.ts";
import { assembleSnapshot } from "../server/src/memory/snapshot.ts";
import { USER_ID } from "../server/src/domain.ts";

const RERUNS = Number(process.env.EVAL_RERUNS ?? 3);
const OUT_ROOT = fileURLToPath(new URL("./runs", import.meta.url));

interface RunOutcome {
  runId: string;
  runStatus: string;
  tools: string[];
  actionStatus: string | null;
  failures: string[];
  passed: boolean;
  judgeSelfScore: number;
  simulatedLabel: number;
  agreement: boolean;
  trace: Record<string, unknown>;
}

function uuid(prefix: "c1" | "c2" | "e5", n: number): string {
  const head = prefix === "c1" ? "c1000000" : prefix === "c2" ? "c2000000" : "e5000000";
  return `${head}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function replacePlaceholders(value: unknown, map: Record<string, string>): unknown {
  const json = JSON.stringify(value);
  let replaced = json;
  for (const [key, replacement] of Object.entries(map)) {
    replaced = replaced.split(`{{${key}}}`).join(replacement);
  }
  return JSON.parse(replaced);
}

function toResponses(
  steps: ScriptStep[],
  map: Record<string, string>,
): AssistantMessage[] {
  return steps.map((step) => {
    const blocks: Array<ReturnType<typeof fauxText> | ReturnType<typeof fauxToolCall>> = [];
    for (const call of step.toolCalls ?? []) {
      blocks.push(
        fauxToolCall(call.name, replacePlaceholders(call.arguments, map) as Record<string, unknown>),
      );
    }
    if (step.text) blocks.push(fauxText(step.text));
    if (!blocks.length) blocks.push(fauxText("好的。"));
    return fauxAssistantMessage(blocks, {
      stopReason: step.toolCalls?.length ? "toolUse" : "stop",
    });
  });
}

async function counts(pool: Pool): Promise<{ contacts: number; events: number }> {
  const result = await pool.query<{ contacts: number; events: number }>(
    `SELECT
       (SELECT count(*) FROM contacts)::int AS contacts,
       (SELECT count(*) FROM calendar_events)::int AS events`,
  );
  return result.rows[0] ?? { contacts: 0, events: 0 };
}

async function insertContact(
  pool: Pool,
  id: string,
  name: string,
  facts: Record<string, string> = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO contacts (id, user_id, display_name, version, status)
     VALUES ($1, $2, $3, 1, 'active')`,
    [id, USER_ID, name],
  );
  for (const [field, value] of Object.entries(facts)) {
    await pool.query(
      `INSERT INTO contact_facts (contact_id, field, value, status, confidence)
       VALUES ($1, $2, $3, 'confirmed', 'high')`,
      [id, field, value],
    );
  }
}

async function setupCase(
  pool: Pool,
  testCase: EvalCase,
  sequence: number,
): Promise<{
  primaryId: string;
  secondId: string;
  primaryName: string;
  threadId: string;
  eventIds: string[];
  before: { contacts: number; events: number };
}> {
  const primaryId = uuid("c1", sequence);
  const secondId = uuid("c2", sequence);
  const primaryName = testCase.contacts?.[0]?.name ?? `测试对象${sequence}`;
  const secondName = testCase.contacts?.[1]?.name ?? "第二联系人";

  await insertContact(pool, primaryId, primaryName, testCase.contacts?.[0]?.facts);
  if (testCase.contacts?.[1]) {
    await insertContact(pool, secondId, secondName, testCase.contacts?.[1]?.facts);
  }

  const eventIds: string[] = [];
  for (const [index, event] of (testCase.events ?? []).entries()) {
    const id = uuid("e5", sequence * 10 + index);
    eventIds.push(id);
    await pool.query(
      `INSERT INTO calendar_events
         (id, user_id, title, starts_at, ends_at, timezone, contact_ids, version)
       VALUES ($1, $2, $3, $4, $5, 'Asia/Shanghai', $6::uuid[], 1)`,
      [
        id,
        USER_ID,
        event.title,
        event.startsAt,
        event.endsAt,
        event.contactIndex === 1 ? [secondId] : [primaryId],
      ],
    );
  }

  for (const memory of testCase.memories ?? []) {
    await pool.query(
      `INSERT INTO memory_items (contact_id, kind, content, status, confidence)
       VALUES ($1, $2, $3, $4, 'medium')`,
      [
        memory.contactIndex === 1 ? secondId : primaryId,
        memory.kind,
        memory.content,
        memory.status ?? "candidate",
      ],
    );
  }

  const thread = await pool.query<{ id: string }>(
    "INSERT INTO threads (user_id, title) VALUES ($1, $2) RETURNING id",
    [USER_ID, `eval-${testCase.id}`],
  );
  const threadId = thread.rows[0]?.id;
  if (!threadId) throw new Error("创建 eval thread 失败");

  return {
    primaryId,
    secondId,
    primaryName,
    threadId,
    eventIds,
    before: await counts(pool),
  };
}

async function runOne(
  pool: Pool,
  testCase: EvalCase,
  sequence: number,
): Promise<RunOutcome> {
  const setup = await setupCase(pool, testCase, sequence);
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<any>;
  const streamFn: StreamFn = (m, context, options) =>
    models.streamSimple(m, context, options);

  const map: Record<string, string> = {
    contactId: setup.primaryId,
    contactId2: setup.secondId,
    contactName: setup.primaryName,
    eventId: setup.eventIds[0] ?? "",
  };

  faux.setResponses(toResponses(testCase.script, map));

  const started = await startMessageRun(pool, {
    threadId: setup.threadId,
    userId: USER_ID,
    input: {
      text: testCase.input,
      images: [],
      pageContext: { contactId: setup.primaryId },
      permissionMode: testCase.permissionMode ?? "ask",
      requestId: `eval-${testCase.id}-${sequence}`,
    },
    streamFn,
    model,
    awaitCompletion: true,
  });

  const runIds = [started.runId];
  let finalRunId = started.runId;

  let runRow = await pool.query<{ status: string }>(
    "SELECT status FROM agent_runs WHERE id = $1",
    [finalRunId],
  );

  // 问卷 / 联网授权恢复
  if (runRow.rows[0]?.status === "waiting_questionnaire" && testCase.resume?.kind === "questionnaire") {
    const q = await pool.query<{ id: string }>(
      "SELECT id FROM questionnaires WHERE run_id = $1 AND status = 'pending' LIMIT 1",
      [finalRunId],
    );
    if (q.rows[0]) {
      faux.setResponses(toResponses(testCase.resume.script, map));
      const resumed = await answerQuestionnaire(
        pool,
        q.rows[0].id,
        USER_ID,
        testCase.resume.answers ?? {},
        { streamFn, model, models, awaitCompletion: true },
      );
      runIds.push(resumed.runId);
      finalRunId = resumed.runId;
      runRow = await pool.query<{ status: string }>(
        "SELECT status FROM agent_runs WHERE id = $1",
        [finalRunId],
      );
    }
  }

  if (runRow.rows[0]?.status === "waiting_permission" && testCase.resume?.kind === "permission") {
    const p = await pool.query<{ id: string }>(
      "SELECT id FROM permission_requests WHERE run_id = $1 AND status = 'pending' LIMIT 1",
      [finalRunId],
    );
    if (p.rows[0]) {
      faux.setResponses(toResponses(testCase.resume.script, map));
      const resumed = await decidePermission(
        pool,
        p.rows[0].id,
        USER_ID,
        testCase.resume.decision ?? "granted",
        { streamFn, model, models, awaitCompletion: true },
      );
      runIds.push(resumed.runId);
      finalRunId = resumed.runId;
      runRow = await pool.query<{ status: string }>(
        "SELECT status FROM agent_runs WHERE id = $1",
        [finalRunId],
      );
    }
  }

  // Action 确认 / 拒绝 / 只跑洞察
  const actionResult = await pool.query<{
    id: string;
    status: string;
    contact_id: string | null;
  }>(
    `SELECT id, status, contact_id FROM actions
     WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [setup.threadId],
  );
  const action = actionResult.rows[0];
  let insightResults: Array<{ status: string; error?: string }> = [];
  let duplicateSameReceipt: boolean | null = null;
  let confirmError: string | null = null;

  if (action && testCase.afterPropose === "reject") {
    await rejectAction(pool, action.id, USER_ID);
  }

  if (action && testCase.autoConfirm) {
    if (testCase.beforeConfirm === "bump_contact_version") {
      await pool.query("UPDATE contacts SET version = version + 1 WHERE id = $1", [
        setup.primaryId,
      ]);
    }

    const evidence = await pool.query<{ id: string }>(
      "SELECT id FROM evidence WHERE thread_id = $1 ORDER BY captured_at DESC LIMIT 1",
      [setup.threadId],
    );
    map.actionId = action.id;
    map.evidenceId = evidence.rows[0]?.id ?? "";

    const insightResponses = testCase.insightResponse
      ? Array.isArray(testCase.insightResponse)
        ? testCase.insightResponse
        : [testCase.insightResponse]
      : [{ insight: null, memoryDraft: null }];

    faux.setResponses(
      insightResponses.map((response) =>
        fauxAssistantMessage(JSON.stringify(replacePlaceholders(response, map))),
      ),
    );

    try {
      const confirmed = await confirmAction(pool, action.id, USER_ID, { models, model });
      insightResults = confirmed.insight;

      if (testCase.afterConfirm === "duplicate_confirm") {
        const again = await confirmAction(pool, action.id, USER_ID, { models, model });
        duplicateSameReceipt = again.receipt.id === confirmed.receipt.id;
      }
    } catch (error) {
      // CAS 冲突是预期结果；其他确认失败会在断言里变成 failure。
      confirmError = (error as Error).message;
    }
  }

  if (action && testCase.runInsightWithoutConfirm) {
    insightResults = await runInsightForAction(pool, action.id, { models, model });
  }

  // 汇总
  const tools = await pool.query<{ tool_name: string }>(
    "SELECT tool_name FROM tool_calls WHERE run_id = ANY($1::uuid[]) ORDER BY started_at",
    [runIds],
  );
  const toolNames = [...new Set(tools.rows.map((row) => row.tool_name))];

  const latestAction = await pool.query<{ status: string }>(
    `SELECT status FROM actions WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [setup.threadId],
  );
  const questionnaire = await pool.query<{ status: string }>(
    `SELECT status FROM questionnaires WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [setup.threadId],
  );
  const insights = await pool.query<{ id: string }>(
    "SELECT id FROM insights WHERE contact_id = $1",
    [setup.primaryId],
  );
  const candidates = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM memory_items WHERE contact_id = $1 AND status = 'candidate'",
    [setup.primaryId],
  );
  const intents = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM meet_intents WHERE contact_id = $1",
    [setup.primaryId],
  );

  const after = await counts(pool);
  const failures: string[] = [];
  const expect = testCase.expect;

  if (expect.runStatus && runRow.rows[0]?.status !== expect.runStatus) {
    failures.push(`run_status=${runRow.rows[0]?.status}，期望 ${expect.runStatus}`);
  }
  for (const tool of expect.tools ?? []) {
    if (!toolNames.includes(tool)) failures.push(`缺少工具 ${tool}`);
  }
  if (expect.actionStatus && latestAction.rows[0]?.status !== expect.actionStatus) {
    failures.push(`action_status=${latestAction.rows[0]?.status}，期望 ${expect.actionStatus}`);
  }
  if (expect.contactCountDelta !== undefined) {
    const delta = after.contacts - setup.before.contacts;
    if (delta !== expect.contactCountDelta) {
      failures.push(`contact_delta=${delta}，期望 ${expect.contactCountDelta}`);
    }
  }
  if (expect.eventCountDelta !== undefined) {
    const delta = after.events - setup.before.events;
    if (delta !== expect.eventCountDelta) {
      failures.push(`event_delta=${delta}，期望 ${expect.eventCountDelta}`);
    }
  }
  if (expect.candidateMemoryCount !== undefined) {
    const count = candidates.rows[0]?.count ?? 0;
    if (count !== expect.candidateMemoryCount) {
      failures.push(`candidate_count=${count}，期望 ${expect.candidateMemoryCount}`);
    }
  }
  if (expect.meetIntentCount !== undefined) {
    const count = intents.rows[0]?.count ?? 0;
    if (count !== expect.meetIntentCount) {
      failures.push(`meet_intent_count=${count}，期望 ${expect.meetIntentCount}`);
    }
  }
  if (expect.questionnaireStatus !== undefined) {
    const status = questionnaire.rows[0]?.status ?? null;
    if (status !== expect.questionnaireStatus) {
      failures.push(`questionnaire_status=${status}，期望 ${expect.questionnaireStatus}`);
    }
  }
  if (expect.insightCount !== undefined && insights.rows.length !== expect.insightCount) {
    failures.push(`insight_count=${insights.rows.length}，期望 ${expect.insightCount}`);
  }
  if (expect.insightFailed && !insightResults.some((result) => result.status === "failed")) {
    failures.push("期望洞察失败，但没有 failed 结果");
  }
  if (expect.secondConfirmSameReceipt && duplicateSameReceipt !== true) {
    failures.push("重复确认没有返回同一个 receipt");
  }
  if (confirmError && expect.actionStatus !== "conflict") {
    failures.push(`confirm_error: ${confirmError}`);
  }
  if (expect.actionRejected && latestAction.rows[0]?.status !== "rejected") {
    failures.push("Action 没有被拒绝");
  }
  if (expect.contactStatus === "merged") {
    const merged = await pool.query<{ status: string }>(
      "SELECT status FROM contacts WHERE id = $1",
      [setup.secondId],
    );
    if (merged.rows[0]?.status !== "merged") failures.push("源联系人没有变成 merged");
  }

  if (expect.crossContactLeak) {
    const { snapshot } = await assembleSnapshot(pool, {
      contactId: setup.primaryId,
      threadId: setup.threadId,
    });
    const leaked = snapshot.contact?.facts.some(
      (fact) => fact.value.includes("SECOND-ONLY") || fact.value.includes("第二公司"),
    );
    if (leaked) failures.push("主联系人快照泄漏了第二个人事实");
  }

  const passed = failures.length === 0;
  const judgeSelfScore = passed ? 2 : 0;
  const simulatedLabel = testCase.judgePass ? 2 : 0;

  return {
    runId: finalRunId,
    runStatus: runRow.rows[0]?.status ?? "unknown",
    tools: toolNames,
    actionStatus: latestAction.rows[0]?.status ?? null,
    failures,
    passed,
    judgeSelfScore,
    simulatedLabel,
    agreement: judgeSelfScore === simulatedLabel,
    trace: {
      case_id: testCase.id,
      run_ids: runIds,
      run_status: runRow.rows[0]?.status,
      tools: toolNames,
      action: action ?? null,
      action_status_after: latestAction.rows[0]?.status ?? null,
      questionnaire_status: questionnaire.rows[0]?.status ?? null,
      insights: insights.rows.length,
      insight_results: insightResults,
      duplicate_same_receipt: duplicateSameReceipt,
      confirm_error: confirmError,
      failures,
    },
  };
}

async function main(): Promise<void> {
  const pool = createTestPool();
  try {
    await runMigrations(pool, { reset: true, log: () => {} });
    await seedDatabase(pool);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = path.join(OUT_ROOT, timestamp);
    await mkdir(path.join(outDir, "traces"), { recursive: true });

    const results: Array<{ case: EvalCase; runs: RunOutcome[] }> = [];
    let sequence = 1;

    for (const testCase of cases) {
      const runs: RunOutcome[] = [];
      for (let rerun = 0; rerun < RERUNS; rerun += 1) {
        sequence += 1;
        try {
          runs.push(await runOne(pool, testCase, sequence));
        } catch (error) {
          runs.push({
            runId: "",
            runStatus: "error",
            tools: [],
            actionStatus: null,
            failures: [(error as Error).message],
            passed: false,
            judgeSelfScore: 0,
            simulatedLabel: testCase.judgePass ? 2 : 0,
            agreement: false,
            trace: { case_id: testCase.id, error: (error as Error).message },
          });
        }
      }
      results.push({ case: testCase, runs });
      const stable = runs.every((run) => run.passed);
      console.log(
        `${testCase.id} ${testCase.title}: ${stable ? "PASS" : "FAIL"} ${runs
          .map((run) => (run.passed ? "✓" : "✗"))
          .join("")}`,
      );
      for (const [index, run] of runs.entries()) {
        await writeFile(
          path.join(outDir, "traces", `${testCase.id}-${index + 1}.json`),
          JSON.stringify(run.trace, null, 2),
        );
      }
    }

    const totalRuns = results.reduce((sum, item) => sum + item.runs.length, 0);
    const passedRuns = results.reduce(
      (sum, item) => sum + item.runs.filter((run) => run.passed).length,
      0,
    );
    const stableCases = results.filter((item) => item.runs.every((run) => run.passed)).length;
    const agreements = results.filter((item) => item.runs[0]?.agreement).length;

    const report = {
      generatedAt: new Date().toISOString(),
      mode: "mock",
      calibration: "simulated",
      reruns: RERUNS,
      totalCases: results.length,
      totalRuns,
      stablePassCases: stableCases,
      stablePassRate: stableCases / results.length,
      singlePassRuns: passedRuns,
      singlePassRate: passedRuns / totalRuns,
      simulatedAgreement: agreements / results.length,
      cases: results.map((item) => ({
        case_id: item.case.id,
        category: item.case.category,
        title: item.case.title,
        stablePass: item.runs.every((run) => run.passed),
        passedRuns: item.runs.filter((run) => run.passed).length,
        runs: item.runs.map((run) => ({
          runId: run.runId,
          runStatus: run.runStatus,
          tools: run.tools,
          actionStatus: run.actionStatus,
          passed: run.passed,
          judgeSelfScore: run.judgeSelfScore,
          simulatedLabel: run.simulatedLabel,
          agreement: run.agreement,
          failures: run.failures,
        })),
      })),
    };

    await writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
    const markdown = [
      "# Relationship Agent Eval Report",
      "",
      `- 生成时间：${report.generatedAt}`,
      `- 模式：${report.mode}`,
      `- 校准：${report.calibration}（不是人工一致率）`,
      `- 用例：${report.totalCases}，复跑：${report.reruns}，总 run：${report.totalRuns}`,
      `- 稳定通过率：${(report.stablePassRate * 100).toFixed(1)}%（${stableCases}/${results.length}）`,
      `- 单次通过率：${(report.singlePassRate * 100).toFixed(1)}%（${passedRuns}/${totalRuns}）`,
      `- 模拟校准一致率：${(report.simulatedAgreement * 100).toFixed(1)}%`,
      "",
      "| Case | 标题 | 稳定通过 | 通过 run | 失败原因 |",
      "|---|---|---|---|---|",
      ...results.map((item) => {
        const failures = item.runs.flatMap((run) => run.failures);
        return `| ${item.case.id} | ${item.case.title} | ${item.runs.every((run) => run.passed) ? "是" : "否"} | ${item.runs.filter((run) => run.passed).length}/${item.runs.length} | ${failures[0] ?? ""} |`;
      }),
      "",
    ].join("\n");
    await writeFile(path.join(outDir, "report.md"), markdown);

    console.log("");
    console.log(`报告：${path.join(outDir, "report.md")}`);
    console.log(
      `稳定通过 ${stableCases}/${results.length}；单次通过 ${passedRuns}/${totalRuns}；模拟一致率 ${(report.simulatedAgreement * 100).toFixed(1)}%`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
