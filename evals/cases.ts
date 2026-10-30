export interface ScriptedCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ScriptStep {
  toolCalls?: ScriptedCall[];
  text?: string;
}

export interface EvalCase {
  id: string;
  category: "M" | "E" | "Q" | "A" | "I";
  title: string;
  input: string;
  permissionMode?: "ask" | "full";
  contacts?: Array<{ name: string; facts?: Record<string, string> }>;
  events?: Array<{ title: string; startsAt: string; endsAt: string; contactIndex?: number }>;
  memories?: Array<{
    contactIndex: number;
    kind: string;
    content: string;
    status?: "candidate" | "confirmed";
  }>;
  script: ScriptStep[];
  resume?: {
    kind: "questionnaire" | "permission";
    answers?: Record<string, string | string[]>;
    decision?: "granted" | "denied";
    script: ScriptStep[];
  };
  autoConfirm?: boolean;
  afterPropose?: "reject";
  afterConfirm?: "duplicate_confirm";
  beforeConfirm?: "bump_contact_version";
  insightResponse?: unknown;
  runInsightWithoutConfirm?: boolean;
  expect: {
    runStatus?: string;
    tools?: string[];
    actionStatus?: string;
    noContactWrite?: boolean;
    contactCountDelta?: number;
    eventCountDelta?: number;
    candidateMemoryCount?: number;
    meetIntentCount?: number;
    questionnaireStatus?: string | null;
    insightCount?: number;
    insightFailed?: boolean;
    secondConfirmSameReceipt?: boolean;
    crossContactLeak?: boolean;
    actionRejected?: boolean;
    contactStatus?: "active" | "merged";
  };
  /** 模拟复核员的标签，用于校准管线，不代表真人评分。 */
  judgePass?: boolean;
}

const noopText: ScriptStep = { text: "已处理。" };

export const cases: EvalCase[] = [
  // ---------- M：主 Agent 工具选择 ----------
  {
    id: "M01",
    category: "M",
    title: "先搜联系人再读档案",
    input: "看看这个人的档案",
    script: [
      { toolCalls: [{ name: "search_contacts", arguments: { query: "{{contactName}}" } }] },
      { toolCalls: [{ name: "get_contact_profile", arguments: { contactId: "{{contactId}}" } }] },
      noopText,
    ],
    expect: { runStatus: "completed", tools: ["search_contacts", "get_contact_profile"] },
    judgePass: true,
  },
  {
    id: "M02",
    category: "M",
    title: "读指定时间范围日程",
    input: "看看下个月有什么安排",
    script: [
      {
        toolCalls: [
          {
            name: "list_calendar_events",
            arguments: {
              from: "2026-11-01T00:00:00Z",
              to: "2026-11-30T00:00:00Z",
              contactId: "{{contactId}}",
            },
          },
        ],
      },
      noopText,
    ],
    expect: { runStatus: "completed", tools: ["list_calendar_events"] },
    judgePass: true,
  },
  {
    id: "M03",
    category: "M",
    title: "计算空档",
    input: "下周三哪个时段有空",
    script: [
      {
        toolCalls: [
          {
            name: "find_free_slots",
            arguments: {
              from: "2026-11-02T00:00:00+08:00",
              to: "2026-11-08T23:59:00+08:00",
              durationMinutes: 60,
            },
          },
        ],
      },
      noopText,
    ],
    expect: { runStatus: "completed", tools: ["find_free_slots"] },
    judgePass: true,
  },
  {
    id: "M04",
    category: "M",
    title: "生成会前简报",
    input: "给我一份会前简报",
    script: [
      {
        toolCalls: [
          { name: "generate_meeting_brief", arguments: { contactId: "{{contactId}}" } },
        ],
      },
      noopText,
    ],
    expect: { runStatus: "completed", tools: ["generate_meeting_brief"] },
    judgePass: true,
  },
  {
    id: "M05",
    category: "M",
    title: "读见面意图",
    input: "之前是不是提过想见面",
    script: [
      { toolCalls: [{ name: "list_meet_intents", arguments: { contactId: "{{contactId}}" } }] },
      noopText,
    ],
    expect: { runStatus: "completed", tools: ["list_meet_intents"] },
    judgePass: true,
  },
  {
    id: "M06",
    category: "M",
    title: "搜不到人时如实回答",
    input: "查一下根本不存在的人",
    script: [
      { toolCalls: [{ name: "search_contacts", arguments: { query: "不存在的人-zzz" } }] },
      { text: "没有找到这个人。" },
    ],
    expect: { runStatus: "completed", tools: ["search_contacts"] },
    judgePass: true,
  },
  {
    id: "M07",
    category: "M",
    title: "不需要工具时直接回答",
    input: "你好，今天先不处理事情",
    script: [{ text: "好的，有需要随时说。" }],
    expect: { runStatus: "completed", tools: [] },
    judgePass: true,
  },
  {
    id: "M08",
    category: "M",
    title: "同一轮并行读两个来源",
    input: "搜一下人，同时看看日程",
    script: [
      {
        toolCalls: [
          { name: "search_contacts", arguments: { query: "{{contactName}}" } },
          {
            name: "list_calendar_events",
            arguments: {
              from: "2026-11-01T00:00:00Z",
              to: "2026-11-30T00:00:00Z",
            },
          },
        ],
      },
      noopText,
    ],
    expect: { runStatus: "completed", tools: ["search_contacts", "list_calendar_events"] },
    judgePass: true,
  },

  // ---------- E：证据与人物上下文 ----------
  {
    id: "E01",
    category: "E",
    title: "用户陈述进入候选记忆",
    input: "他喜欢早上开会",
    script: [
      {
        toolCalls: [
          {
            name: "record_candidate_memory",
            arguments: {
              contactId: "{{contactId}}",
              kind: "preference",
              content: "喜欢早上开会",
            },
          },
        ],
      },
      noopText,
    ],
    expect: { runStatus: "completed", candidateMemoryCount: 1 },
    judgePass: true,
  },
  {
    id: "E02",
    category: "E",
    title: "没有截图时记录理解要报错",
    input: "把这张截图记一下",
    script: [
      {
        toolCalls: [
          {
            name: "record_screenshot_understanding",
            arguments: { summary: "名片上写着产品经理" },
          },
        ],
      },
      { text: "这一轮没有截图证据可记录。" },
    ],
    expect: { runStatus: "completed", tools: ["record_screenshot_understanding"] },
    judgePass: true,
  },
  {
    id: "E03",
    category: "E",
    title: "见面意图进入候选",
    input: "帮我记一下想约他喝咖啡",
    script: [
      {
        toolCalls: [
          {
            name: "record_meet_intent",
            arguments: { contactId: "{{contactId}}", intent: "想约咖啡" },
          },
        ],
      },
      noopText,
    ],
    expect: { runStatus: "completed", meetIntentCount: 1 },
    judgePass: true,
  },
  {
    id: "E04",
    category: "E",
    title: "读第二个人不会泄漏到第一个人",
    input: "看看另一个人",
    contacts: [
      { name: "主联系人", facts: { company: "主公司" } },
      { name: "第二联系人", facts: { company: "第二公司-SECOND-ONLY" } },
    ],
    script: [
      {
        toolCalls: [
          { name: "get_contact_profile", arguments: { contactId: "{{contactId2}}" } },
        ],
      },
      noopText,
    ],
    expect: { runStatus: "completed", crossContactLeak: true },
    judgePass: true,
  },
  {
    id: "E05",
    category: "E",
    title: "读取档案包含已确认事实",
    input: "他的公司是什么",
    script: [
      { toolCalls: [{ name: "get_contact_profile", arguments: { contactId: "{{contactId}}" } }] },
      { text: "档案里有公司和城市信息。" },
    ],
    expect: { runStatus: "completed", tools: ["get_contact_profile"] },
    judgePass: true,
  },
  {
    id: "E06",
    category: "E",
    title: "候选记忆必须带 evidence",
    input: "记一下他喜欢茶",
    script: [
      {
        toolCalls: [
          {
            name: "record_candidate_memory",
            arguments: {
              contactId: "{{contactId}}",
              kind: "preference",
              content: "喜欢茶",
            },
          },
        ],
      },
      noopText,
    ],
    expect: { runStatus: "completed", candidateMemoryCount: 1 },
    judgePass: true,
  },
  {
    id: "E07",
    category: "E",
    title: "人物隔离：不自动注入第二个人的事实",
    input: "这个人怎么样",
    contacts: [
      { name: "甲", facts: { company: "甲公司" } },
      { name: "乙", facts: { city: "乙城-SECOND-ONLY" } },
    ],
    script: [
      { toolCalls: [{ name: "get_contact_profile", arguments: { contactId: "{{contactId}}" } }] },
      noopText,
    ],
    expect: { runStatus: "completed", crossContactLeak: true },
    judgePass: true,
  },
  {
    id: "E08",
    category: "E",
    title: "候选印象与偏好分开记录",
    input: "他说话很直接",
    script: [
      {
        toolCalls: [
          {
            name: "record_candidate_memory",
            arguments: {
              contactId: "{{contactId}}",
              kind: "impression",
              content: "说话直接",
            },
          },
        ],
      },
      noopText,
    ],
    expect: { runStatus: "completed", candidateMemoryCount: 1 },
    judgePass: true,
  },

  // ---------- Q：问卷与会话恢复 ----------
  {
    id: "Q01",
    category: "Q",
    title: "缺日期时发起问卷",
    input: "帮我约个人",
    script: [
      {
        toolCalls: [
          {
            name: "questionnaire",
            arguments: {
              questions: [
                { id: "when", prompt: "哪一天？", kind: "date", required: true },
              ],
            },
          },
        ],
      },
    ],
    expect: { runStatus: "waiting_questionnaire", questionnaireStatus: "pending" },
    judgePass: true,
  },
  {
    id: "Q02",
    category: "Q",
    title: "问卷最多 4 题",
    input: "帮我安排一下",
    script: [
      {
        toolCalls: [
          {
            name: "questionnaire",
            arguments: {
              questions: [
                { id: "q1", prompt: "哪天？", kind: "date" },
                { id: "q2", prompt: "几点？", kind: "text" },
                { id: "q3", prompt: "在哪？", kind: "text" },
                { id: "q4", prompt: "聊什么？", kind: "text" },
              ],
            },
          },
        ],
      },
    ],
    expect: { runStatus: "waiting_questionnaire", questionnaireStatus: "pending" },
    judgePass: true,
  },
  {
    id: "Q03",
    category: "Q",
    title: "回答问卷后继续提案",
    input: "帮我约他",
    script: [
      {
        toolCalls: [
          {
            name: "questionnaire",
            arguments: {
              questions: [{ id: "when", prompt: "哪天？", kind: "date" }],
            },
          },
        ],
      },
    ],
    resume: {
      kind: "questionnaire",
      answers: { when: "2026-11-05" },
      script: [
        {
          toolCalls: [
            {
              name: "propose_action",
              arguments: {
                type: "create_event",
                payload: {
                  type: "create_event",
                  title: "与{{contactName}}见面",
                  startsAt: "2026-11-05T15:00:00+08:00",
                  endsAt: "2026-11-05T16:00:00+08:00",
                  timezone: "Asia/Shanghai",
                  contactIds: ["{{contactId}}"],
                },
                rationale: "用户回答日期后提案",
              },
            },
          ],
        },
      ],
    },
    expect: { runStatus: "proposed", actionStatus: "proposed" },
    judgePass: true,
  },
  {
    id: "Q04",
    category: "Q",
    title: "回答文本问题后直接回答",
    input: "帮我约他",
    script: [
      {
        toolCalls: [
          {
            name: "questionnaire",
            arguments: {
              questions: [{ id: "when", prompt: "什么时候方便？", kind: "text" }],
            },
          },
        ],
      },
    ],
    resume: {
      kind: "questionnaire",
      answers: { when: "11 月 5 日下午三点" },
      script: [{ text: "好的，时间是 11 月 5 日下午三点。" }],
    },
    expect: { runStatus: "completed", questionnaireStatus: "answered" },
    judgePass: true,
  },
  {
    id: "Q05",
    category: "Q",
    title: "未回答问卷时不能开新 run",
    input: "帮我约他",
    script: [
      {
        toolCalls: [
          {
            name: "questionnaire",
            arguments: {
              questions: [{ id: "when", prompt: "哪天？", kind: "date" }],
            },
          },
        ],
      },
    ],
    expect: { runStatus: "waiting_questionnaire" },
    judgePass: true,
  },
  {
    id: "Q06",
    category: "Q",
    title: "超规格问卷被工具拒绝",
    input: "帮我安排",
    script: [
      {
        toolCalls: [
          {
            name: "questionnaire",
            arguments: {
              questions: [
                { id: "q1", prompt: "1", kind: "text" },
                { id: "q2", prompt: "2", kind: "text" },
                { id: "q3", prompt: "3", kind: "text" },
                { id: "q4", prompt: "4", kind: "text" },
                { id: "q5", prompt: "5", kind: "text" },
              ],
            },
          },
        ],
      },
      { text: "问卷格式不合法，我改一下。" },
    ],
    expect: { runStatus: "completed", questionnaireStatus: null },
    judgePass: false,
  },
  {
    id: "Q07",
    category: "Q",
    title: "终态后不再调用模型",
    input: "帮我约他",
    script: [
      {
        toolCalls: [
          {
            name: "questionnaire",
            arguments: {
              questions: [{ id: "when", prompt: "哪天？", kind: "date" }],
            },
          },
        ],
      },
    ],
    expect: { runStatus: "waiting_questionnaire", tools: ["questionnaire"] },
    judgePass: true,
  },
  {
    id: "Q08",
    category: "Q",
    title: "ask 模式联网先暂停",
    input: "读一下 https://example.com",
    script: [
      {
        toolCalls: [
          { name: "fetch_public_url", arguments: { url: "https://example.com" } },
        ],
      },
    ],
    expect: { runStatus: "waiting_permission" },
    judgePass: true,
  },

  // ---------- A：Action / receipt / 权限 ----------
  {
    id: "A01",
    category: "A",
    title: "只提案不写入",
    input: "帮我建一个新联系人",
    script: [
      {
        toolCalls: [
          {
            name: "propose_action",
            arguments: {
              type: "create_contact",
              payload: { type: "create_contact", displayName: "新联系人A01" },
              rationale: "用户要求创建联系人",
            },
          },
        ],
      },
    ],
    expect: {
      runStatus: "proposed",
      actionStatus: "proposed",
      contactCountDelta: 0,
    },
    judgePass: true,
  },
  {
    id: "A02",
    category: "A",
    title: "确认后才创建联系人",
    input: "帮我建一个新联系人",
    script: [
      {
        toolCalls: [
          {
            name: "propose_action",
            arguments: {
              type: "create_contact",
              payload: { type: "create_contact", displayName: "新联系人A02" },
              rationale: "用户要求创建联系人",
            },
          },
        ],
      },
    ],
    autoConfirm: true,
    expect: {
      runStatus: "proposed",
      actionStatus: "executed",
      contactCountDelta: 1,
      insightCount: 0,
    },
    judgePass: true,
  },
  {
    id: "A03",
    category: "A",
    title: "CAS 冲突时不覆盖",
    input: "把他的电话改成 13900000009",
    script: [
      {
        toolCalls: [
          {
            name: "propose_action",
            arguments: {
              type: "update_contact",
              payload: {
                type: "update_contact",
                contactId: "{{contactId}}",
                patch: { phone: "13900000009" },
                baseVersion: 1,
              },
              rationale: "更新电话",
            },
          },
        ],
      },
    ],
    autoConfirm: true,
    beforeConfirm: "bump_contact_version",
    expect: {
      runStatus: "proposed",
      actionStatus: "conflict",
      noContactWrite: true,
    },
    judgePass: true,
  },
  {
    id: "A04",
    category: "A",
    title: "重复确认幂等",
    input: "帮我建联系人",
    script: [
      {
        toolCalls: [
          {
            name: "propose_action",
            arguments: {
              type: "create_contact",
              payload: { type: "create_contact", displayName: "幂等联系人" },
              rationale: "创建",
            },
          },
        ],
      },
    ],
    autoConfirm: true,
    afterConfirm: "duplicate_confirm",
    expect: {
      runStatus: "proposed",
      actionStatus: "executed",
      secondConfirmSameReceipt: true,
    },
    judgePass: true,
  },
  {
    id: "A05",
    category: "A",
    title: "拒绝 Action 不写入",
    input: "帮我建联系人",
    script: [
      {
        toolCalls: [
          {
            name: "propose_action",
            arguments: {
              type: "create_contact",
              payload: { type: "create_contact", displayName: "被拒绝联系人" },
              rationale: "创建",
            },
          },
        ],
      },
    ],
    afterPropose: "reject",
    expect: {
      runStatus: "proposed",
      actionStatus: "rejected",
      actionRejected: true,
      contactCountDelta: 0,
    },
    judgePass: true,
  },
  {
    id: "A06",
    category: "A",
    title: "合并联系人保留 target 并归档 source",
    input: "把这两个人合并",
    contacts: [
      { name: "合并目标", facts: { company: "目标公司" } },
      { name: "合并来源", facts: { company: "来源公司" } },
    ],
    script: [
      {
        toolCalls: [
          {
            name: "propose_action",
            arguments: {
              type: "merge_contacts",
              payload: {
                type: "merge_contacts",
                sourceContactIds: ["{{contactId2}}"],
                targetContactId: "{{contactId}}",
                fieldChoices: { company: "目标公司" },
                baseVersion: 1,
              },
              rationale: "用户要求合并",
            },
          },
        ],
      },
    ],
    autoConfirm: true,
    expect: {
      runStatus: "proposed",
      actionStatus: "executed",
      contactCountDelta: 0,
      contactStatus: "merged",
    },
    judgePass: true,
  },
  {
    id: "A07",
    category: "A",
    title: "确认后删除日程",
    input: "把那个日程删掉",
    events: [
      {
        title: "待删除日程",
        startsAt: "2026-12-01T10:00:00+08:00",
        endsAt: "2026-12-01T11:00:00+08:00",
      },
    ],
    script: [
      {
        toolCalls: [
          {
            name: "propose_action",
            arguments: {
              type: "delete_event",
              payload: {
                type: "delete_event",
                eventId: "{{eventId}}",
                baseVersion: 1,
              },
              rationale: "用户要求删除",
            },
          },
        ],
      },
    ],
    autoConfirm: true,
    expect: {
      runStatus: "proposed",
      actionStatus: "executed",
      eventCountDelta: -1,
    },
    judgePass: true,
  },
  {
    id: "A08",
    category: "A",
    title: "确认后创建日程并关联联系人",
    input: "帮他约个会",
    script: [
      {
        toolCalls: [
          {
            name: "propose_action",
            arguments: {
              type: "create_event",
              payload: {
                type: "create_event",
                title: "新建会议",
                startsAt: "2026-12-02T10:00:00+08:00",
                endsAt: "2026-12-02T11:00:00+08:00",
                timezone: "Asia/Shanghai",
                contactIds: ["{{contactId}}"],
              },
              rationale: "用户要求约见",
            },
          },
        ],
      },
    ],
    autoConfirm: true,
    insightResponse: { insight: null, memoryDraft: null },
    expect: {
      runStatus: "proposed",
      actionStatus: "executed",
      eventCountDelta: 1,
      insightCount: 0,
    },
    judgePass: true,
  },

  // ---------- I：Insight 与记忆 ----------
  {
    id: "I01",
    category: "I",
    title: "有效洞察落库",
    input: "帮他约个会",
    script: [
      {
        toolCalls: [
          {
            name: "propose_action",
            arguments: {
              type: "create_event",
              payload: {
                type: "create_event",
                title: "洞察测试会议",
                startsAt: "2026-12-03T10:00:00+08:00",
                endsAt: "2026-12-03T11:00:00+08:00",
                timezone: "Asia/Shanghai",
                contactIds: ["{{contactId}}"],
              },
              rationale: "约见",
            },
          },
        ],
      },
    ],
    autoConfirm: true,
    insightResponse: {
      insight: {
        content: "用户愿意主动安排见面，关系推进信号明确。",
        confidence: "medium",
        recheckAt: "2026-12-10T00:00:00Z",
        evidenceIds: ["{{evidenceId}}"],
        sourceIds: ["{{evidenceId}}"],
      },
      memoryDraft: null,
    },
    expect: {
      runStatus: "proposed",
      actionStatus: "executed",
      insightCount: 1,
    },
    judgePass: true,
  },
  {
    id: "I02",
    category: "I",
    title: "伪造 sourceID 整条丢弃",
    input: "帮他约个会",
    script: [
      {
        toolCalls: [
          {
            name: "propose_action",
            arguments: {
              type: "create_event",
              payload: {
                type: "create_event",
                title: "伪造来源测试",
                startsAt: "2026-12-04T10:00:00+08:00",
                endsAt: "2026-12-04T11:00:00+08:00",
                timezone: "Asia/Shanghai",
                contactIds: ["{{contactId}}"],
              },
              rationale: "约见",
            },
          },
        ],
      },
    ],
    autoConfirm: true,
    insightResponse: {
      insight: {
        content: "伪造来源",
        confidence: "low",
        recheckAt: null,
        evidenceIds: ["ev_fake"],
        sourceIds: ["ev_fake"],
      },
      memoryDraft: null,
    },
    expect: {
      runStatus: "proposed",
      actionStatus: "executed",
      insightCount: 0,
      insightFailed: true,
    },
    judgePass: true,
  },
  {
    id: "I03",
    category: "I",
    title: "没有新信号返回 null",
    input: "帮他约个会",
    script: [
      {
        toolCalls: [
          {
            name: "propose_action",
            arguments: {
              type: "create_event",
              payload: {
                type: "create_event",
                title: "无洞察会议",
                startsAt: "2026-12-05T10:00:00+08:00",
                endsAt: "2026-12-05T11:00:00+08:00",
                timezone: "Asia/Shanghai",
                contactIds: ["{{contactId}}"],
              },
              rationale: "约见",
            },
          },
        ],
      },
    ],
    autoConfirm: true,
    insightResponse: { insight: null, memoryDraft: null },
    expect: { insightCount: 0 },
    judgePass: true,
  },
  {
    id: "I04",
    category: "I",
    title: "洞察附带候选记忆",
    input: "帮他约个会",
    script: [
      {
        toolCalls: [
          {
            name: "propose_action",
            arguments: {
              type: "create_event",
              payload: {
                type: "create_event",
                title: "候选记忆会议",
                startsAt: "2026-12-06T10:00:00+08:00",
                endsAt: "2026-12-06T11:00:00+08:00",
                timezone: "Asia/Shanghai",
                contactIds: ["{{contactId}}"],
              },
              rationale: "约见",
            },
          },
        ],
      },
    ],
    autoConfirm: true,
    insightResponse: {
      insight: {
        content: "对方对线下见面接受度高。",
        confidence: "medium",
        recheckAt: null,
        evidenceIds: ["{{evidenceId}}"],
        sourceIds: ["{{evidenceId}}"],
      },
      memoryDraft: {
        content: "对线下见面接受度较高",
        evidenceIds: ["{{evidenceId}}"],
      },
    },
    expect: {
      insightCount: 1,
      candidateMemoryCount: 1,
    },
    judgePass: true,
  },
  {
    id: "I05",
    category: "I",
    title: "允许 act_ 来源",
    input: "帮他约个会",
    script: [
      {
        toolCalls: [
          {
            name: "propose_action",
            arguments: {
              type: "create_event",
              payload: {
                type: "create_event",
                title: "Action 来源测试",
                startsAt: "2026-12-07T10:00:00+08:00",
                endsAt: "2026-12-07T11:00:00+08:00",
                timezone: "Asia/Shanghai",
                contactIds: ["{{contactId}}"],
              },
              rationale: "约见",
            },
          },
        ],
      },
    ],
    autoConfirm: true,
    insightResponse: {
      insight: {
        content: "行动产生了可复用的关系信号。",
        confidence: "low",
        recheckAt: null,
        evidenceIds: ["{{evidenceId}}"],
        sourceIds: ["act_{{actionId}}"],
      },
      memoryDraft: null,
    },
    expect: { insightCount: 1 },
    judgePass: true,
  },
  {
    id: "I06",
    category: "I",
    title: "多联系人只给有来源的人写洞察",
    input: "帮两个人一起约",
    contacts: [
      { name: "多人甲", facts: { company: "甲公司" } },
      { name: "多人乙", facts: { company: "乙公司" } },
    ],
    script: [
      {
        toolCalls: [
          {
            name: "propose_action",
            arguments: {
              type: "create_event",
              payload: {
                type: "create_event",
                title: "多人会议",
                startsAt: "2026-12-08T10:00:00+08:00",
                endsAt: "2026-12-08T11:00:00+08:00",
                timezone: "Asia/Shanghai",
                contactIds: ["{{contactId}}", "{{contactId2}}"],
              },
              rationale: "多人约见",
            },
          },
        ],
      },
    ],
    autoConfirm: true,
    insightResponse: [
      {
        insight: {
          content: "甲对多人会面接受度高。",
          confidence: "medium",
          recheckAt: null,
          evidenceIds: ["{{evidenceId}}"],
          sourceIds: ["{{evidenceId}}"],
        },
        memoryDraft: null,
      },
      { insight: null, memoryDraft: null },
    ],
    expect: { insightCount: 1 },
    judgePass: true,
  },
  {
    id: "I07",
    category: "I",
    title: "memoryDraft 伪造来源整条回滚",
    input: "帮他约个会",
    script: [
      {
        toolCalls: [
          {
            name: "propose_action",
            arguments: {
              type: "create_event",
              payload: {
                type: "create_event",
                title: "草案回滚测试",
                startsAt: "2026-12-09T10:00:00+08:00",
                endsAt: "2026-12-09T11:00:00+08:00",
                timezone: "Asia/Shanghai",
                contactIds: ["{{contactId}}"],
              },
              rationale: "约见",
            },
          },
        ],
      },
    ],
    autoConfirm: true,
    insightResponse: {
      insight: null,
      memoryDraft: { content: "伪造草案", evidenceIds: ["ev_fake"] },
    },
    expect: {
      actionStatus: "executed",
      insightCount: 0,
      candidateMemoryCount: 0,
      insightFailed: true,
    },
    judgePass: true,
  },
  {
    id: "I08",
    category: "I",
    title: "没有回执不跑洞察",
    input: "帮他约个会",
    script: [
      {
        toolCalls: [
          {
            name: "propose_action",
            arguments: {
              type: "create_event",
              payload: {
                type: "create_event",
                title: "无回执测试",
                startsAt: "2026-12-10T10:00:00+08:00",
                endsAt: "2026-12-10T11:00:00+08:00",
                timezone: "Asia/Shanghai",
                contactIds: ["{{contactId}}"],
              },
              rationale: "约见",
            },
          },
        ],
      },
    ],
    runInsightWithoutConfirm: true,
    expect: { runStatus: "proposed", actionStatus: "proposed", insightCount: 0 },
    judgePass: true,
  },
];
