import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Pool, type PoolClient } from "pg";

export type JobStage = "understanding" | "researching" | "analyzing" | "curriculum" | "pre-exam" | "chapters" | "videos" | "flashcards" | "final-exam" | "completed" | "error";

export type Source = {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  sourceType: string;
  credibilityScore: number;
};

export type Video = {
  title: string;
  url: string;
  domain: string;
  chapterId?: string | null;
};

export type ChapterContent = {
  why?: string;
  learningObjectives?: string[];
  prerequisites?: string[];
  detailedExplanation?: string;
  coreConcepts?: { title: string; explanation: string }[];
  stepByStep?: string[];
  realWorldExamples?: string[];
  practicalExamples?: string[];
  technicalExamples?: string[];
  commonMistakes?: string[];
  troubleshooting?: string[];
  bestPractices?: string[];
  importantTerms?: { term: string; definition: string }[];
  keyTakeaways?: string[];
  visualExplanation?: string;
  practicalExercise?: string;
  scenarioExercise?: string;
  quickQuiz?: any[];
  furtherReading?: { title: string; url: string }[];
  sources?: Source[];
};

export type Module = {
  id: string;
  topic: string;
  title: string;
  description: string;
  difficulty: string;
  goal: string;
  style: string;
  estimatedMinutes: number;
  objectives: string[];
  chapters: {
    id: string;
    title: string;
    description: string;
    minutes: number;
    completed: boolean;
    // Backwards-compatible summary fields
    lesson?: string;
    keyTakeaways?: string[];
    example?: string;
    practicePrompt?: string;
    // New rich structured content persisted as JSONB
    content?: ChapterContent;
  }[];
  sources: Source[];
  videos: Video[];
  createdAt: string;
  progress: number;
  preExamScore?: number;
  finalScore?: number;
};

export type GenerationJob = {
  id: string;
  topic: string;
  stage: JobStage;
  completedStages: JobStage[];
  error?: string;
  moduleId?: string;
  createdAt: string;
};

type State = { modules: Module[]; jobs: GenerationJob[] };
type StorageMode = "postgres" | "json";

const statePath = join(process.cwd(), "data", "state.json");
const initialState: State = { modules: [], jobs: [] };
const migrationId = "003_chapter_study_materials_and_videos";

const migrationSql = `
  CREATE TABLE IF NOT EXISTS study_modules (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    goal TEXT NOT NULL,
    style TEXT NOT NULL,
    estimated_minutes INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    pre_exam_score INTEGER,
    final_score INTEGER
  );

  CREATE TABLE IF NOT EXISTS study_chapters (
    id TEXT PRIMARY KEY,
    module_id TEXT NOT NULL REFERENCES study_modules(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL
  );
  ALTER TABLE study_chapters ADD COLUMN IF NOT EXISTS lesson TEXT NOT NULL DEFAULT '';
  ALTER TABLE study_chapters ADD COLUMN IF NOT EXISTS key_takeaways JSONB NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE study_chapters ADD COLUMN IF NOT EXISTS example TEXT NOT NULL DEFAULT '';
  ALTER TABLE study_chapters ADD COLUMN IF NOT EXISTS practice_prompt TEXT NOT NULL DEFAULT '';
  -- new: structured chapter content
  ALTER TABLE study_chapters ADD COLUMN IF NOT EXISTS content JSONB NOT NULL DEFAULT '{}'::jsonb;

  CREATE TABLE IF NOT EXISTS learning_objectives (
    module_id TEXT NOT NULL REFERENCES study_modules(id) ON DELETE CASCADE,
    objective TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (module_id, sort_order)
  );

  CREATE TABLE IF NOT EXISTS study_sources (
    id BIGSERIAL PRIMARY KEY,
    module_id TEXT NOT NULL REFERENCES study_modules(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    domain TEXT NOT NULL,
    snippet TEXT NOT NULL,
    source_type TEXT NOT NULL,
    credibility_score INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS generation_jobs (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    stage TEXT NOT NULL,
    completed_stages JSONB NOT NULL DEFAULT '[]'::jsonb,
    error TEXT,
    module_id TEXT REFERENCES study_modules(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL
  );

  CREATE INDEX IF NOT EXISTS study_chapters_module_id_idx ON study_chapters(module_id);
  CREATE INDEX IF NOT EXISTS learning_objectives_module_id_idx ON learning_objectives(module_id);
  CREATE INDEX IF NOT EXISTS study_sources_module_id_idx ON study_sources(module_id);
  CREATE INDEX IF NOT EXISTS generation_jobs_created_at_idx ON generation_jobs(created_at DESC);

  CREATE TABLE IF NOT EXISTS study_videos (
    id BIGSERIAL PRIMARY KEY,
    module_id TEXT NOT NULL REFERENCES study_modules(id) ON DELETE CASCADE,
    chapter_id TEXT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    domain TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS study_videos_module_id_idx ON study_videos(module_id);

  -- Exams and questions
  CREATE TABLE IF NOT EXISTS study_exams (
    id TEXT PRIMARY KEY,
    module_id TEXT NOT NULL REFERENCES study_modules(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    total_questions INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS study_questions (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL REFERENCES study_exams(id) ON DELETE CASCADE,
    module_id TEXT NOT NULL REFERENCES study_modules(id) ON DELETE CASCADE,
    chapter_id TEXT NULL,
    concept_id TEXT NULL,
    question_text TEXT NOT NULL,
    type TEXT NOT NULL,
    options JSONB,
    correct_answer JSONB,
    explanation TEXT,
    difficulty TEXT,
    sort_order INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS study_questions_exam_id_idx ON study_questions(exam_id);

  -- Flashcards
  CREATE TABLE IF NOT EXISTS study_flashcards (
    id TEXT PRIMARY KEY,
    module_id TEXT NOT NULL REFERENCES study_modules(id) ON DELETE CASCADE,
    chapter_id TEXT NULL,
    concept_id TEXT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    difficulty TEXT,
    last_reviewed_at TIMESTAMPTZ,
    next_review_at TIMESTAMPTZ,
    review_count INTEGER DEFAULT 0,
    ease_factor REAL DEFAULT 2.5,
    interval INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS study_flashcards_module_id_idx ON study_flashcards(module_id);

  -- Tutor conversations (lightweight reference to module/chapter)
  CREATE TABLE IF NOT EXISTS tutor_conversations (
    id TEXT PRIMARY KEY,
    module_id TEXT NULL REFERENCES study_modules(id) ON DELETE SET NULL,
    chapter_id TEXT NULL,
    convo JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );

  -- General (user-level) conversation memory used as a persistent "brain" for General AI
  -- Legacy single-entry per-user storage (kept for backward compatibility)
  CREATE TABLE IF NOT EXISTS general_conversations (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    convo JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );

  -- New: support multiple user threads (multi-chat sidebar)
  CREATE TABLE IF NOT EXISTS general_threads (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    title TEXT NOT NULL,
    convo JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    last_updated TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS general_threads_username_idx ON general_threads(username);

  -- Per-user structured memory store (user 'brain')
  CREATE TABLE IF NOT EXISTS general_brain (
    username TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

function readState(): State {
  try {
    if (!existsSync(statePath)) return { ...initialState, modules: [], jobs: [] };
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<State>;
    return {
      modules: Array.isArray(parsed.modules) ? parsed.modules : [],
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
  } catch {
    return { ...initialState, modules: [], jobs: [] };
  }
}

let state = readState();
let pool: Pool | null = null;
let storageMode: StorageMode = "json";

function persistJson() {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

async function migrateDatabase(database: Pool) {
  await database.query("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const result = await database.query<{ id: string }>("SELECT id FROM schema_migrations WHERE id = $1", [migrationId]);
  if (result.rowCount) return;

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query(migrationSql);
    await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migrationId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!pool) throw new Error("PostgreSQL storage is not initialized");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function replaceModule(client: PoolClient, module: Module) {
  await client.query(
    `INSERT INTO study_modules (id, topic, title, description, difficulty, goal, style, estimated_minutes, created_at, progress, pre_exam_score, final_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id) DO UPDATE SET topic = EXCLUDED.topic, title = EXCLUDED.title, description = EXCLUDED.description,
       difficulty = EXCLUDED.difficulty, goal = EXCLUDED.goal, style = EXCLUDED.style, estimated_minutes = EXCLUDED.estimated_minutes,
       created_at = EXCLUDED.created_at, progress = EXCLUDED.progress, pre_exam_score = EXCLUDED.pre_exam_score, final_score = EXCLUDED.final_score`,
    [module.id, module.topic, module.title, module.description, module.difficulty, module.goal, module.style, module.estimatedMinutes, module.createdAt, module.progress, module.preExamScore ?? null, module.finalScore ?? null],
  );
  await client.query("DELETE FROM study_chapters WHERE module_id = $1", [module.id]);
  await client.query("DELETE FROM learning_objectives WHERE module_id = $1", [module.id]);
  await client.query("DELETE FROM study_sources WHERE module_id = $1", [module.id]);
  await client.query("DELETE FROM study_videos WHERE module_id = $1", [module.id]);

  for (const [sortOrder, chapter] of module.chapters.entries()) {
    // Persist both legacy summary fields and the new structured content JSONB
    await client.query(
      "INSERT INTO study_chapters (id, module_id, title, description, minutes, completed, sort_order, lesson, key_takeaways, example, practice_prompt, content) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb)",
      [
        chapter.id,
        module.id,
        chapter.title,
        chapter.description,
        chapter.minutes,
        chapter.completed,
        sortOrder,
        chapter.lesson ?? "",
        JSON.stringify(chapter.keyTakeaways ?? []),
        chapter.example ?? "",
        chapter.practicePrompt ?? "",
        JSON.stringify(chapter.content ?? {}),
      ],
    );
  }
  for (const [sortOrder, objective] of module.objectives.entries()) {
    await client.query("INSERT INTO learning_objectives (module_id, objective, sort_order) VALUES ($1, $2, $3)", [module.id, objective, sortOrder]);
  }
  for (const source of module.sources) {
    await client.query(
      "INSERT INTO study_sources (module_id, title, url, domain, snippet, source_type, credibility_score) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [module.id, source.title, source.url, source.domain, source.snippet, source.sourceType, source.credibilityScore],
    );
  }
  for (const video of module.videos) {
    // allow optional chapter association: video.chapterId
    await client.query(
      "INSERT INTO study_videos (module_id, chapter_id, title, url, domain) VALUES ($1, $2, $3, $4, $5)",
      [module.id, (video as any).chapterId ?? null, video.title, video.url, video.domain],
    );
  }
}

async function replaceJob(client: PoolClient, job: GenerationJob) {
  await client.query(
    `INSERT INTO generation_jobs (id, topic, stage, completed_stages, error, module_id, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET topic = EXCLUDED.topic, stage = EXCLUDED.stage, completed_stages = EXCLUDED.completed_stages,
       error = EXCLUDED.error, module_id = EXCLUDED.module_id, created_at = EXCLUDED.created_at`,
    [job.id, job.topic, job.stage, JSON.stringify(job.completedStages), job.error ?? null, job.moduleId ?? null, job.createdAt],
  );
}

async function loadDatabaseState(database: Pool): Promise<State> {
  const [moduleRows, chapterRows, objectiveRows, sourceRows, videoRows, jobRows] = await Promise.all([
    database.query("SELECT * FROM study_modules ORDER BY created_at DESC"),
    database.query("SELECT * FROM study_chapters ORDER BY module_id, sort_order"),
    database.query("SELECT * FROM learning_objectives ORDER BY module_id, sort_order"),
    database.query("SELECT * FROM study_sources ORDER BY module_id, id"),
    database.query("SELECT * FROM study_videos ORDER BY module_id, id"),
    database.query("SELECT * FROM generation_jobs ORDER BY created_at DESC"),
  ]);

  const chaptersByModule = new Map<string, Module["chapters"]>();
  for (const row of chapterRows.rows) {
    const chapters = chaptersByModule.get(row.module_id) || [];
    chapters.push({
      id: row.id,
      title: row.title,
      description: row.description,
      minutes: row.minutes,
      completed: row.completed,
      lesson: row.lesson || undefined,
      keyTakeaways: Array.isArray(row.key_takeaways) ? row.key_takeaways : [],
      example: row.example || undefined,
      practicePrompt: row.practice_prompt || undefined,
    content: row.content || undefined,
  });
  chaptersByModule.set(row.module_id, chapters);
  }
  const objectivesByModule = new Map<string, string[]>();
  for (const row of objectiveRows.rows) objectivesByModule.set(row.module_id, [...(objectivesByModule.get(row.module_id) || []), row.objective]);
  const sourcesByModule = new Map<string, Source[]>();
  for (const row of sourceRows.rows) {
    const sources = sourcesByModule.get(row.module_id) || [];
    sources.push({ title: row.title, url: row.url, domain: row.domain, snippet: row.snippet, sourceType: row.source_type, credibilityScore: row.credibility_score });
    sourcesByModule.set(row.module_id, sources);
  }
  const videosByModule = new Map<string, Video[]>();
  for (const row of videoRows.rows) {
    const videos = videosByModule.get(row.module_id) || [];
    videos.push({ title: row.title, url: row.url, domain: row.domain, chapterId: row.chapter_id ?? undefined });
    videosByModule.set(row.module_id, videos);
  }

  return {
    modules: moduleRows.rows.map((row) => ({
      id: row.id, topic: row.topic, title: row.title, description: row.description, difficulty: row.difficulty, goal: row.goal, style: row.style,
      estimatedMinutes: row.estimated_minutes, objectives: objectivesByModule.get(row.id) || [], chapters: chaptersByModule.get(row.id) || [],
      sources: sourcesByModule.get(row.id) || [], videos: videosByModule.get(row.id) || [], createdAt: new Date(row.created_at).toISOString(), progress: row.progress,
      ...(row.pre_exam_score === null ? {} : { preExamScore: row.pre_exam_score }),
      ...(row.final_score === null ? {} : { finalScore: row.final_score }),
    })),
    jobs: jobRows.rows.map((row) => ({
      id: row.id, topic: row.topic, stage: row.stage as JobStage, completedStages: row.completed_stages as JobStage[],
      ...(row.error === null ? {} : { error: row.error }), ...(row.module_id === null ? {} : { moduleId: row.module_id }), createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

export async function initializeStore() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.warn("[storage] DATABASE_URL is not set; using data/state.json. Add DATABASE_URL to .env to enable PostgreSQL.");
    return;
  }

  const candidate = new Pool({ connectionString: databaseUrl });
  try {
    await migrateDatabase(candidate);

    // Ensure critical columns exist even if migrations were previously partially applied.
    // Some environments may have the schema_migrations entry but lack later ALTER TABLE additions.
    try {
      // Check for several columns we rely on (content, key_takeaways, example, practice_prompt)
      const colCheck = await candidate.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'study_chapters' AND column_name IN ('content','key_takeaways','example','practice_prompt')",
      );
      const existing = new Set(colCheck.rows.map((r: any) => r.column_name));
      const needed: { name: string; sql: string }[] = [];
      if (!existing.has('content')) needed.push({ name: 'content', sql: "ALTER TABLE study_chapters ADD COLUMN IF NOT EXISTS content JSONB NOT NULL DEFAULT '{}'::jsonb" });
      if (!existing.has('key_takeaways')) needed.push({ name: 'key_takeaways', sql: "ALTER TABLE study_chapters ADD COLUMN IF NOT EXISTS key_takeaways JSONB NOT NULL DEFAULT '[]'::jsonb" });
      if (!existing.has('example')) needed.push({ name: 'example', sql: "ALTER TABLE study_chapters ADD COLUMN IF NOT EXISTS example TEXT NOT NULL DEFAULT ''" });
      if (!existing.has('practice_prompt')) needed.push({ name: 'practice_prompt', sql: "ALTER TABLE study_chapters ADD COLUMN IF NOT EXISTS practice_prompt TEXT NOT NULL DEFAULT ''" });
      if (needed.length) {
        await candidate.query('BEGIN');
        for (const add of needed) {
          await candidate.query(add.sql);
          console.log(`[storage] added missing column study_chapters.${add.name}`);
        }
        await candidate.query('COMMIT');
      }
    } catch (err) {
      try { await candidate.query('ROLLBACK'); } catch {};
      console.warn('[storage] additional schema ensure step failed', err);
    }

    // Ensure other tables/columns required by newer code exist. This is defensive for environments
    // where the migration marker was recorded but subsequent CREATE/ALTER statements were not applied.
    try {
      const tableCheck = await candidate.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('study_videos','study_flashcards')",
      );
      const existingTables = new Set(tableCheck.rows.map((r: any) => r.table_name));
      if (!existingTables.has('study_videos')) {
        await candidate.query(`
          CREATE TABLE IF NOT EXISTS study_videos (
            id BIGSERIAL PRIMARY KEY,
            module_id TEXT NOT NULL REFERENCES study_modules(id) ON DELETE CASCADE,
            chapter_id TEXT NULL,
            title TEXT NOT NULL,
            url TEXT NOT NULL,
            domain TEXT NOT NULL
          );
        `);
        await candidate.query("CREATE INDEX IF NOT EXISTS study_videos_module_id_idx ON study_videos(module_id)");
        console.log('[storage] created missing table study_videos');
      } else {
        // ensure chapter_id column exists
        const col = await candidate.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'study_videos' AND column_name = 'chapter_id'");
        if (col.rowCount === 0) {
          await candidate.query("ALTER TABLE study_videos ADD COLUMN IF NOT EXISTS chapter_id TEXT NULL");
          console.log('[storage] added missing column study_videos.chapter_id');
        }
      }

      if (!existingTables.has('study_flashcards')) {
        await candidate.query(`
          CREATE TABLE IF NOT EXISTS study_flashcards (
            id TEXT PRIMARY KEY,
            module_id TEXT NOT NULL REFERENCES study_modules(id) ON DELETE CASCADE,
            chapter_id TEXT NULL,
            concept_id TEXT NULL,
            question TEXT NOT NULL,
            answer TEXT NOT NULL,
            difficulty TEXT,
            last_reviewed_at TIMESTAMPTZ,
            next_review_at TIMESTAMPTZ,
            review_count INTEGER DEFAULT 0,
            ease_factor REAL DEFAULT 2.5,
            interval INTEGER DEFAULT 0
          );
        `);
        await candidate.query("CREATE INDEX IF NOT EXISTS study_flashcards_module_id_idx ON study_flashcards(module_id)");
        console.log('[storage] created missing table study_flashcards');
      }

      // Ensure tutor_conversations table exists (used for lightweight persistence of tutor metadata)
      const tutorCheck = await candidate.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tutor_conversations'");
      if (tutorCheck.rowCount === 0) {
        await candidate.query(`
          CREATE TABLE IF NOT EXISTS tutor_conversations (
            id TEXT PRIMARY KEY,
            module_id TEXT NULL REFERENCES study_modules(id) ON DELETE SET NULL,
            chapter_id TEXT NULL,
            convo JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
          );
        `);
        console.log('[storage] created missing table tutor_conversations');
      }

      // Ensure general_conversations table exists (user-level persistent memory for General AI)
      const generalCheck = await candidate.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'general_conversations'");
      if (generalCheck.rowCount === 0) {
        await candidate.query(`
          CREATE TABLE IF NOT EXISTS general_conversations (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            convo JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
          );
        `);
        console.log('[storage] created missing table general_conversations');
      }

      // Ensure general_threads table exists (multi-thread conversation support)
      const threadsCheck = await candidate.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'general_threads'");
      if (threadsCheck.rowCount === 0) {
        await candidate.query(`
          CREATE TABLE IF NOT EXISTS general_threads (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            title TEXT NOT NULL,
            convo JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            last_updated TIMESTAMPTZ NOT NULL
          );
        `);
        await candidate.query("CREATE INDEX IF NOT EXISTS general_threads_username_idx ON general_threads(username)");
        console.log('[storage] created missing table general_threads');
      }

      // Ensure per-user structured memory table exists
      const brainCheck = await candidate.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'general_brain'");
      if (brainCheck.rowCount === 0) {
        await candidate.query(`
          CREATE TABLE IF NOT EXISTS general_brain (
            username TEXT PRIMARY KEY,
            data JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        console.log('[storage] created missing table general_brain');
      }
    } catch (err) {
      console.warn('[storage] additional table ensure step failed', err);
    }

    const counts = await candidate.query<{ modules: string; jobs: string }>(
      "SELECT (SELECT COUNT(*)::text FROM study_modules) AS modules, (SELECT COUNT(*)::text FROM generation_jobs) AS jobs",
    );
    if (counts.rows[0].modules === "0" && counts.rows[0].jobs === "0" && (state.modules.length > 0 || state.jobs.length > 0)) {
      pool = candidate;
      await withTransaction(async (client) => {
        for (const module of state.modules) await replaceModule(client, module);
        for (const job of state.jobs) await replaceJob(client, job);
      });
    }
    pool = candidate;
    state = await loadDatabaseState(candidate);
    storageMode = "postgres";
    console.log("[storage] PostgreSQL connected; migrations applied.");
  } catch (error) {
    await candidate.end();
    const message = error instanceof Error ? error.message : "Unknown PostgreSQL error";
    throw new Error(`PostgreSQL initialization failed: ${message}`);
  }
}

export async function closeStore() {
  if (pool) await pool.end();
  pool = null;
}

export function storageStatus() {
  return { mode: storageMode, databaseConfigured: Boolean(process.env.DATABASE_URL?.trim()) };
}

async function insertExam(client: PoolClient, exam: { id: string; moduleId: string; type: string; title: string; description: string; totalQuestions: number }) {
  await client.query(
    "INSERT INTO study_exams (id, module_id, type, title, description, total_questions, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW()) ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, total_questions = EXCLUDED.total_questions",
    [exam.id, exam.moduleId, exam.type, exam.title, exam.description, exam.totalQuestions],
  );
}

async function insertQuestions(client: PoolClient, questions: any[]) {
  for (const [idx, q] of questions.entries()) {
    await client.query(
      `INSERT INTO study_questions (id, exam_id, module_id, chapter_id, concept_id, question_text, type, options, correct_answer, explanation, difficulty, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET question_text = EXCLUDED.question_text, options = EXCLUDED.options, correct_answer = EXCLUDED.correct_answer, explanation = EXCLUDED.explanation, difficulty = EXCLUDED.difficulty`,
      [q.id, q.examId, q.moduleId, q.chapterId ?? null, q.conceptId ?? null, q.question, q.type, JSON.stringify(q.options ?? null), JSON.stringify(q.correctAnswer ?? null), q.explanation ?? null, q.difficulty ?? null, q.sortOrder ?? idx],
    );
  }
}

async function insertFlashcards(client: PoolClient, flashcards: any[]) {
  for (const f of flashcards) {
    await client.query(
      `INSERT INTO study_flashcards (id, module_id, chapter_id, concept_id, question, answer, difficulty, last_reviewed_at, next_review_at, review_count, ease_factor, interval)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET question = EXCLUDED.question, answer = EXCLUDED.answer, difficulty = EXCLUDED.difficulty`,
      [f.id, f.moduleId, f.chapterId ?? null, f.conceptId ?? null, f.question, f.answer, f.difficulty ?? null, f.lastReviewedAt ?? null, f.nextReviewAt ?? null, f.reviewCount ?? 0, f.easeFactor ?? 2.5, f.interval ?? 0],
    );
  }
}

export async function getExamByModule(moduleId: string, type: string) {
  if (!pool) throw new Error("PostgreSQL storage is not initialized");
  const client = await pool.connect();
  try {
    const examRes = await client.query("SELECT * FROM study_exams WHERE module_id = $1 AND type = $2", [moduleId, type]);
    if (examRes.rowCount === 0) return null;
    const exam = examRes.rows[0];
    const questionsRes = await client.query("SELECT * FROM study_questions WHERE exam_id = $1 ORDER BY sort_order", [exam.id]);
    return { exam: { id: exam.id, moduleId: exam.module_id, type: exam.type, title: exam.title, description: exam.description, totalQuestions: exam.total_questions, createdAt: exam.created_at }, questions: questionsRes.rows.map((q) => ({ id: q.id, examId: q.exam_id, moduleId: q.module_id, chapterId: q.chapter_id, conceptId: q.concept_id, question: q.question_text, type: q.type, options: q.options, correctAnswer: q.correct_answer, explanation: q.explanation, difficulty: q.difficulty })) };
  } finally {
    client.release();
  }
}

export async function getFlashcardsByModule(moduleId: string) {
  if (!pool) throw new Error("PostgreSQL storage is not initialized");
  const client = await pool.connect();
  try {
    const res = await client.query("SELECT * FROM study_flashcards WHERE module_id = $1 ORDER BY next_review_at NULLS FIRST, id", [moduleId]);
    return res.rows.map((r) => ({ id: r.id, moduleId: r.module_id, chapterId: r.chapter_id, conceptId: r.concept_id, question: r.question, answer: r.answer, difficulty: r.difficulty, lastReviewedAt: r.last_reviewed_at, nextReviewAt: r.next_review_at, reviewCount: r.review_count, easeFactor: r.ease_factor, interval: r.interval }));
  } finally {
    client.release();
  }
}

export async function recordFlashcardReview(flashcardId: string, result: { rating: "again" | "hard" | "good" | "easy" }) {
  if (!pool) throw new Error("PostgreSQL storage is not initialized");
  return await withTransaction(async (client) => {
    const now = new Date();
    const row = await client.query("SELECT * FROM study_flashcards WHERE id = $1", [flashcardId]);
    if (row.rowCount === 0) throw new Error("Flashcard not found");
    const card = row.rows[0];
    let ease = card.ease_factor || 2.5;
    let interval = card.interval || 0;
    let reviewCount = (card.review_count || 0) + 1;
    if (result.rating === "again") { interval = 1; ease = Math.max(1.3, ease - 0.2); }
    else if (result.rating === "hard") { interval = Math.max(1, Math.round(interval * 1.2)); ease = Math.max(1.3, ease - 0.1); }
    else if (result.rating === "good") { interval = Math.max(1, Math.round(interval * ease)); }
    else if (result.rating === "easy") { interval = Math.max(1, Math.round(interval * ease * 1.3)); ease = Math.min(4.0, ease + 0.15); }
    const next = new Date(Date.now() + interval * 24 * 60 * 60 * 1000);
    await client.query("UPDATE study_flashcards SET last_reviewed_at = NOW(), next_review_at = $1, review_count = $2, ease_factor = $3, interval = $4 WHERE id = $5", [next.toISOString(), reviewCount, ease, interval, flashcardId]);
    return { nextReviewAt: next.toISOString(), reviewCount, ease, interval };
  });
}

export const store = {  modules: () => state.modules,
  getModule: (id: string) => state.modules.find((module) => module.id === id),
  addModule: async (module: Module) => {
    if (pool) await withTransaction((client) => replaceModule(client, module));
    state.modules = [module, ...state.modules.filter((item) => item.id !== module.id)];
    if (!pool) persistJson();
  },
  updateModule: async (id: string, patch: Partial<Module>) => {
    const current = state.modules.find((module) => module.id === id);
    if (!current) return;
    const next = { ...current, ...patch };
    if (pool) await withTransaction((client) => replaceModule(client, next));
    state.modules = state.modules.map((module) => module.id === id ? next : module);
    if (!pool) persistJson();
  },
  deleteModule: async (id: string) => {
    if (!state.modules.some((module) => module.id === id)) return false;
    if (pool) {
      await withTransaction(async (client) => {
        await client.query("DELETE FROM study_modules WHERE id = $1", [id]);
      });
    }
    state.modules = state.modules.filter((module) => module.id !== id);
    if (!pool) persistJson();
    return true;
  },
  jobs: () => state.jobs,
  getJob: (id: string) => state.jobs.find((job) => job.id === id),
  addJob: async (job: GenerationJob) => {
    if (pool) await withTransaction((client) => replaceJob(client, job));
    state.jobs = [job, ...state.jobs.filter((item) => item.id !== job.id)];
    if (!pool) persistJson();
  },
  updateJob: async (id: string, patch: Partial<GenerationJob>) => {
    const current = state.jobs.find((job) => job.id === id);
    if (!current) return;
    const next = { ...current, ...patch };
    if (pool) await withTransaction((client) => replaceJob(client, next));
    state.jobs = state.jobs.map((job) => job.id === id ? next : job);
    if (!pool) persistJson();
  },
  // New helpers for exams, questions, and flashcards
  addExam: async (exam: { id: string; moduleId: string; type: string; title: string; description: string; totalQuestions: number }, questions: any[]) => {
    if (!pool) throw new Error("PostgreSQL storage is not initialized");
    await withTransaction(async (client) => {
      await insertExam(client, exam);
    // Regeneration replaces the complete assessment. Remove questions from
    // earlier versions so total_questions and the returned question set stay
    // consistent instead of accumulating stale questions.
    await client.query("DELETE FROM study_questions WHERE exam_id = $1", [exam.id]);
      await insertQuestions(client, questions.map((q: any) => ({ ...q, examId: exam.id, moduleId: exam.moduleId })));
    });
  },
  addFlashcards: async (flashcards: any[]) => {
    if (!pool) throw new Error("PostgreSQL storage is not initialized");
    await withTransaction(async (client) => {
      await insertFlashcards(client, flashcards);
    });
  },
  // lightweight tutor conversation persistence
  addTutorConversation: async (id: string, moduleId: string | null, chapterId: string | null, convo: any) => {
    if (!pool) throw new Error("PostgreSQL storage is not initialized");
    await withTransaction(async (client) => {
      await client.query("INSERT INTO tutor_conversations (id, module_id, chapter_id, convo, created_at) VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (id) DO UPDATE SET convo = EXCLUDED.convo", [id, moduleId ?? null, chapterId ?? null, JSON.stringify(convo)]);
    });
  },
  // persistent general conversation memory per user (used as long-term "brain")
  addGeneralConversation: async (username: string, convo: any) => {
    if (!pool) throw new Error("PostgreSQL storage is not initialized");
    await withTransaction(async (client) => {
      await client.query("INSERT INTO general_conversations (id, username, convo, created_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (id) DO UPDATE SET convo = EXCLUDED.convo, created_at = EXCLUDED.created_at", [username, username, JSON.stringify(convo)]);
    });
  },
  getGeneralConversation: async (username: string) => {
    if (!pool) throw new Error("PostgreSQL storage is not initialized");
    const client = await pool.connect();
    try {
      const res = await client.query("SELECT convo, created_at FROM general_conversations WHERE id = $1", [username]);
      if (res.rowCount === 0) return { convo: [] as any[], createdAt: null as string | null };
      return { convo: res.rows[0].convo || [], createdAt: res.rows[0].created_at ? new Date(res.rows[0].created_at).toISOString() : null };
    } finally {
      client.release();
    }
  },

  // Per-user structured memory (brain) storage
  addGeneralBrain: async (username: string, data: any) => {
    if (!pool) throw new Error("PostgreSQL storage is not initialized");
    await withTransaction(async (client) => {
      await client.query("INSERT INTO general_brain (username, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (username) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at", [username, JSON.stringify(data || {})]);
    });
  },
  getGeneralBrain: async (username: string) => {
    if (!pool) throw new Error("PostgreSQL storage is not initialized");
    const client = await pool.connect();
    try {
      const res = await client.query("SELECT data, updated_at FROM general_brain WHERE username = $1", [username]);
      if (res.rowCount === 0) return { data: {} as any, updatedAt: null as string | null };
      const row = res.rows[0];
      return { data: row.data || {}, updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null };
    } finally {
      client.release();
    }
  },
  deleteGeneralBrain: async (username: string) => {
    if (!pool) throw new Error("PostgreSQL storage is not initialized");
    await withTransaction(async (client) => {
      await client.query("DELETE FROM general_brain WHERE username = $1", [username]);
    });
  },

  // Multi-thread conversation API (per-user threads)
  listGeneralThreads: async (username: string) => {
    if (!pool) throw new Error("PostgreSQL storage is not initialized");
    const client = await pool.connect();
    try {
      const res = await client.query("SELECT id, title, created_at, last_updated, jsonb_array_length(convo) as messages_count FROM general_threads WHERE username = $1 ORDER BY last_updated DESC", [username]);
      return res.rows.map((r: any) => ({ id: r.id, title: r.title, createdAt: r.created_at ? new Date(r.created_at).toISOString() : null, messagesCount: Number(r.messages_count || 0), lastUpdated: r.last_updated ? new Date(r.last_updated).toISOString() : null }));
    } finally {
      client.release();
    }
  },

  addGeneralThread: async (username: string, threadId: string, title: string, convo: any) => {
    if (!pool) throw new Error("PostgreSQL storage is not initialized");
    await withTransaction(async (client) => {
      await client.query("INSERT INTO general_threads (id, username, title, convo, created_at, last_updated) VALUES ($1,$2,$3,$4,NOW(),NOW()) ON CONFLICT (id) DO UPDATE SET convo = EXCLUDED.convo, title = EXCLUDED.title, last_updated = EXCLUDED.last_updated", [threadId, username, title, JSON.stringify(convo || [])]);
    });
  },

  getGeneralThread: async (username: string, threadId: string) => {
    if (!pool) throw new Error("PostgreSQL storage is not initialized");
    const client = await pool.connect();
    try {
      const res = await client.query("SELECT convo, title, created_at, last_updated FROM general_threads WHERE id = $1 AND username = $2", [threadId, username]);
      if (res.rowCount === 0) return { convo: [] as any[], title: null as string | null, createdAt: null as string | null, lastUpdated: null as string | null };
      const row = res.rows[0];
      return { convo: row.convo || [], title: row.title || null, createdAt: row.created_at ? new Date(row.created_at).toISOString() : null, lastUpdated: row.last_updated ? new Date(row.last_updated).toISOString() : null };
    } finally {
      client.release();
    }
  },

  deleteGeneralThread: async (username: string, threadId: string) => {
    if (!pool) throw new Error("PostgreSQL storage is not initialized");
    await withTransaction(async (client) => {
      await client.query("DELETE FROM general_threads WHERE id = $1 AND username = $2", [threadId, username]);
    });
  },
};