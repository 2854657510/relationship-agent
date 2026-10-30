import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// .env 在仓库根目录。server 从子目录启动，不能依赖默认的 cwd 查找。
dotenv.config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string()
    .default("postgres://relationship:relationship@localhost:5432/relationship"),
  TEST_DATABASE_URL: z
    .string()
    .default("postgres://relationship:relationship@localhost:5432/relationship_test"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8787),

  PI_PROVIDER: z.string().default("deepseek"),
  PI_MODEL: z.string().default("deepseek-flash"),
  PI_VISION_MODEL: z.string().default("deepseek-flash"),
  PI_BASE_URL: z.string().optional(),

  EVIDENCE_DIR: z.string().default("./data/evidence"),
  EVIDENCE_TTL_HOURS: z.coerce.number().int().positive().default(24),

  SEARCH_PROVIDER: z.enum(["none", "tavily", "brave"]).default("none"),
  SEARCH_API_KEY: z.string().optional(),

  MAX_TOOL_CALLS: z.coerce.number().int().positive().default(12),
  MAX_RUN_SECONDS: z.coerce.number().int().positive().default(90),

  EVAL_MODE: z.enum(["mock", "live"]).default("mock"),
  CALIBRATION_MODE: z.literal("simulated").default("simulated"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // 配置错误在启动阶段就暴露，不要带着半个配置跑到请求里才炸。
  console.error("环境变量配置错误：", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const evidenceDir = path.isAbsolute(parsed.data.EVIDENCE_DIR)
  ? parsed.data.EVIDENCE_DIR
  : path.resolve(projectRoot, parsed.data.EVIDENCE_DIR);

export const config = {
  nodeEnv: parsed.data.NODE_ENV,
  databaseUrl: parsed.data.DATABASE_URL,
  testDatabaseUrl: parsed.data.TEST_DATABASE_URL,
  host: parsed.data.HOST,
  port: parsed.data.PORT,
  pi: {
    provider: parsed.data.PI_PROVIDER,
    model: parsed.data.PI_MODEL,
    visionModel: parsed.data.PI_VISION_MODEL,
    baseUrl: parsed.data.PI_BASE_URL,
  },
  evidenceDir,
  evidenceTtlHours: parsed.data.EVIDENCE_TTL_HOURS,
  search: {
    provider: parsed.data.SEARCH_PROVIDER,
    apiKey: parsed.data.SEARCH_API_KEY,
  },
  limits: {
    maxToolCalls: parsed.data.MAX_TOOL_CALLS,
    maxRunSeconds: parsed.data.MAX_RUN_SECONDS,
  },
  evalMode: parsed.data.EVAL_MODE,
  calibrationMode: parsed.data.CALIBRATION_MODE,
  // DeepSeek 的鉴权由 pi-ai 从环境变量读，这里只记录是否具备 live 条件。
  hasDeepSeekKey: Boolean(process.env.DEEPSEEK_API_KEY),
} as const;
