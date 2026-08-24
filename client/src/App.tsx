import { useEffect, useMemo, useRef, useState } from "react";
import "./settings.css";
import {
  ArrowRight, BookOpen, Bot, Brain, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Compass, FileText, Flame, GraduationCap, Layers3, LayoutDashboard, Menu, Moon, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Play, Plus, Search, Settings2, Sparkles, Target, TrendingUp, Trophy, Trash2, Upload, Users, X, Zap,
} from "lucide-react";
// Minimal TOTP helpers (no external otplib/qrcode needed)
async function hmacSha1(keyBytes: Uint8Array, message: Uint8Array) {
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: { name: "SHA-1" } }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, message);
  return new Uint8Array(sig);
}

function base32Encode(bytes: Uint8Array) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  // pad not required for secrets
  return output;
}

function base32Decode(str: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = str.replace(/=+$/g, '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes = [] as number[];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < cleaned.length; i++) {
    value = (value << 5) | alphabet.indexOf(cleaned[i]);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

function generateBase32Secret(bytesLength = 20) {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

async function totpAt(secretBase32: string, forTimeStep: number) {
  const key = base32Decode(secretBase32);
  // 8-byte big-endian
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  // forTimeStep may exceed 32 bits; store high and low
  const high = Math.floor(forTimeStep / Math.pow(2, 32));
  const low = forTimeStep & 0xffffffff;
  view.setUint32(0, high);
  view.setUint32(4, low);
  const hmac = await hmacSha1(key, new Uint8Array(buffer));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  const otp = String(code % 1000000).padStart(6, "0");
  return otp;
}

async function verifyTotp(secretBase32: string, token: string, window = 1) {
  const now = Math.floor(Date.now() / 1000);
  const step = 30;
  const t = Math.floor(now / step);
  for (let i = -window; i <= window; i++) {
    const otp = await totpAt(secretBase32, t + i);
    if (otp === token) return true;
  }
  return false;
}

type View = "dashboard" | "explore" | "create" | "modules" | "progress" | "general-chat" | "tutor" | "flashcards" | "plans" | "settings";
type SettingsTab = "ai" | "learning" | "appearance" | "system" | "users";
type Module = { id: string; topic: string; title: string; description: string; difficulty: string; goal: string; style: string; estimatedMinutes: number; objectives: string[]; chapters: { id: string; title: string; description: string; minutes: number; completed: boolean; lesson?: string; keyTakeaways?: string[]; example?: string; practicePrompt?: string; content?: any }[]; sources: { title: string; url: string; domain: string; snippet?: string; sourceType?: string; credibilityScore?: number }[]; videos?: { title: string; url: string; domain: string; chapterId?: string | null }[]; progress: number; createdAt: string };
type OllamaStatus = { connected: boolean; model: string; models: string[]; message: string; baseUrl?: string };
type StudyPlan = { goal: string; deadline: string; minutesPerDay: number; knowledge: string; createdAt: string; days: { day: number; title: string; minutes: number; completed: boolean }[] };

const nav = [
  { id: "dashboard" as View, label: "Dashboard", icon: LayoutDashboard },
  { id: "explore" as View, label: "Explore", icon: Compass },
  { id: "modules" as View, label: "My learning", icon: BookOpen },
  { id: "plans" as View, label: "Study plans", icon: Target },
  { id: "flashcards" as View, label: "Flashcards", icon: Layers3 },
  { id: "progress" as View, label: "Progress", icon: TrendingUp },
];
const secondaryNav = [
  { id: "general-chat" as View, label: "General Chat", icon: Brain },
  { id: "tutor" as View, label: "Tutor", icon: Bot },
  { id: "settings" as View, label: "Settings", icon: Settings2 },
];
const topics = ["Active Directory", "Python fundamentals", "AWS Solutions Architect", "Network troubleshooting", "Linear algebra", "Product management"];

type AccountRecord = { username: string; name: string; password: string; createdAt: string; totpEnabled?: boolean; totpSecret?: string | undefined };
type AuthSession = { username: string; displayName: string; createdAt: string };

const ADMIN_USERNAME = "jimenez.n";
const ADMIN_PASSWORD = "16435209";
const ADMIN_NAME = "Administrator";
const SESSION_STORAGE_KEY = "study-lab-session";
const ACCOUNTS_STORAGE_KEY = "study-lab-accounts";
const LIBRARY_STORAGE_KEY_PREFIX = "study-lab-library-";
const DEFAULT_LIBRARY_MESSAGE = "Everything you create is private to this account and stays in your own study session.";

function getLibraryKey(username: string) { return `${LIBRARY_STORAGE_KEY_PREFIX}${username.toLowerCase()}`; }
function readAccounts(): AccountRecord[] { try { const raw = localStorage.getItem(ACCOUNTS_STORAGE_KEY); return raw ? JSON.parse(raw) as AccountRecord[] : []; } catch { return []; } }
function writeAccounts(accounts: AccountRecord[]) { localStorage.setItem(ACCOUNTS_STORAGE_KEY, JSON.stringify(accounts)); }
function ensureAdminAccount(): AccountRecord[] {
  const accounts = readAccounts();
  const adminExists = accounts.some((account) => account.username.toLowerCase() === ADMIN_USERNAME.toLowerCase());
  if (adminExists) return accounts;
  const seeded = [{ username: ADMIN_USERNAME, name: ADMIN_NAME, password: ADMIN_PASSWORD, createdAt: new Date().toISOString(), totpEnabled: false, totpSecret: undefined }, ...accounts];
  writeAccounts(seeded);
  return seeded;
}
function readSession(): AuthSession | null { try { const raw = sessionStorage.getItem(SESSION_STORAGE_KEY); return raw ? JSON.parse(raw) as AuthSession : null; } catch { return null; } }
function writeSession(session: AuthSession | null) { if (!session) { sessionStorage.removeItem(SESSION_STORAGE_KEY); return; } sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session)); }
function readLibrary(username: string): Module[] { try { const stored = localStorage.getItem(getLibraryKey(username)); return stored ? JSON.parse(stored) as Module[] : []; } catch { return []; } }
function writeLibrary(username: string, modules: Module[]) { localStorage.setItem(getLibraryKey(username), JSON.stringify(modules)); }
function deriveProgress(chapters: Module["chapters"]) { if (!chapters.length) return 0; return Math.round((chapters.filter((chapter) => chapter.completed).length / chapters.length) * 100); }
function createModuleFromTopic(topic: string, options: { goal: string; difficulty: string; style: string; studyTime: string; researchDepth: string }) {
  const cleanTopic = topic.trim() || "General learning";
  const chapterTemplates = [
    { title: "Foundations", description: `Build the core understanding behind ${cleanTopic} and why it matters in real work.`, minutes: 25 },
    { title: "Application", description: `Apply the concept to realistic scenarios and practice turning theory into action.`, minutes: 30 },
    { title: "Problem solving", description: `Gain confidence by working through common obstacles, mistakes, and decision points.`, minutes: 35 },
    { title: "Mastery check", description: `Review your understanding, test your recall, and identify what to practice next.`, minutes: 20 },
  ];
  const chapters = chapterTemplates.map((chapter, index) => ({
    id: `chapter-${index + 1}`,
    title: chapter.title,
    description: chapter.description,
    minutes: chapter.minutes,
    completed: false,
    lesson: `This chapter covers the essentials of ${cleanTopic}. Start by understanding the core idea, then connect it to a real example and apply it in a small practice task.`,
    keyTakeaways: [
      `Understand the core idea behind ${cleanTopic}.`,
      `Connect ${cleanTopic} to a practical scenario.`,
      `Use the concept in a small action-oriented exercise.`,
      `Review what you know and repeat the key steps.`,
    ],
    example: `A realistic example for ${cleanTopic} shows how the idea works in context before you rely on memorization.`,
    practicePrompt: `Explain ${cleanTopic} in your own words and give one real-world example of when it matters.`,
    content: {
      intro: `In this chapter, you will learn the central ideas behind ${cleanTopic}.`,
      concept: `The main concept is to understand how ${cleanTopic} works in practice and why it matters.`,
      workedExample: `A practical example helps connect the theory to a realistic task or decision.`,
      exercise: `Practice by describing the concept in plain language and applying it to a small example.`,
      recap: `The key takeaway is to understand the idea, connect it to action, and test your understanding.`,
      keyTakeaways: [
        `Understand the concept clearly.`,
        `Apply it to a scenario.`,
        `Review and explain it in your own words.`,
      ],
      coreConcepts: [
        { title: "Core idea", explanation: `This concept helps explain the central principles behind ${cleanTopic}.` },
        { title: "Common application", explanation: `Use the idea in a realistic task so the learning becomes practical.`, },
      ],
      stepByStep: ["Review the key idea.", "Connect it to a real task.", "Apply it in practice.", "Reflect on the result."],
      realWorldExamples: [`A realistic scenario for ${cleanTopic}.`],
      practicalExercise: `Apply this concept to one small problem you want to solve in your work or study.`,
      quickQuiz: [{ id: `q-${index + 1}`, question: `What is the main takeaway from this chapter on ${cleanTopic}?`, options: ["Memorize the vocabulary", "Apply the concept to a real task", "Skip the practice step"], correctAnswer: "Apply the concept to a real task", explanation: "The purpose is to use the idea in context, not just repeat definitions." }],
    },
  }));
  const title = cleanTopic.split(/\s+/).slice(0, 3).join(" ");
  const moduleId = `module-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  return {
    id: moduleId,
    topic: cleanTopic,
    title: title.charAt(0).toUpperCase() + title.slice(1),
    description: `A focused study path for ${cleanTopic} designed around ${options.goal.toLowerCase()} goals and a ${options.style.toLowerCase()} learning style.`,
    difficulty: options.difficulty || "Intermediate",
    goal: options.goal || "Professional learning",
    style: options.style || "Balanced",
    estimatedMinutes: Number.parseInt(String(options.studyTime).match(/\d+/)?.[0] || "30", 10) * Math.max(1, chapters.length),
    objectives: [
      `Build a clear understanding of ${cleanTopic}.`,
      `Apply the concept to realistic examples.`,
      `Check your knowledge and focus on weak areas.`,
    ],
    chapters,
    sources: [{ title: `${cleanTopic} overview`, url: "https://example.com", domain: "example.com", snippet: `A study guide for ${cleanTopic}.`, sourceType: "Reference", credibilityScore: 3 }],
    videos: [],
    createdAt: new Date().toISOString(),
    progress: 0,
  } as Module;
}

function getCurrentAccount() { return readSession(); }

function enforceAccountSession(input: RequestInfo | URL, init?: RequestInit) {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const session = getCurrentAccount();
  if (!session) {
    return new Response(JSON.stringify({ error: "Please log in to access your workspace." }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  if (!requestUrl.startsWith("/api/")) return originalFetch(input, init);

  const { pathname } = new URL(requestUrl, "http://localhost");
  const currentModules = readLibrary(session.username);
  const currentJobs = (() => { try { const raw = localStorage.getItem(`${LIBRARY_STORAGE_KEY_PREFIX}jobs-${session.username.toLowerCase()}`); return raw ? JSON.parse(raw) as Array<{ id: string; topic: string; stage: string; completedStages: string[]; moduleId?: string; createdAt: string; error?: string }> : []; } catch { return []; }})();

  if (pathname === "/api/auth/session") return new Response(JSON.stringify({ authenticated: true, user: { username: session.username, displayName: session.displayName } }), { status: 200, headers: { "Content-Type": "application/json" } });
  if (pathname === "/api/auth/logout") { writeSession(null); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }); }
  if (pathname === "/api/modules") return new Response(JSON.stringify({ modules: currentModules }), { status: 200, headers: { "Content-Type": "application/json" } });
  if (pathname.match(/^\/api\/modules\/[^/]+$/)) {
    const moduleId = pathname.split("/").at(-1) || "";
    if (init?.method === "DELETE") {
      const nextModules = currentModules.filter((item) => item.id !== moduleId);
      writeLibrary(session.username, nextModules);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const module = currentModules.find((item) => item.id === moduleId);
    if (!module) return new Response(JSON.stringify({ error: "Module not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ module }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (pathname === "/api/study/generate" && init?.method === "POST") {
    const payload = init.body ? JSON.parse(String(init.body)) : {} as { topic?: string; goal?: string; difficulty?: string; style?: string; studyTime?: string; researchDepth?: string };
    const module = createModuleFromTopic(payload.topic || "General learning", { goal: payload.goal || "Professional learning", difficulty: payload.difficulty || "Intermediate", style: payload.style || "Balanced", studyTime: payload.studyTime || "30 min/day", researchDepth: payload.researchDepth || "basic" });
    const nextModules = [module, ...currentModules];
    writeLibrary(session.username, nextModules);
    const jobId = `job-${Date.now()}`;
    const job = { id: jobId, topic: module.topic, stage: "completed", completedStages: ["understanding", "researching", "analyzing", "curriculum", "chapters"], moduleId: module.id, createdAt: new Date().toISOString() };
    const jobs = [job, ...currentJobs];
    localStorage.setItem(`${LIBRARY_STORAGE_KEY_PREFIX}jobs-${session.username.toLowerCase()}`, JSON.stringify(jobs));
    return new Response(JSON.stringify({ jobId, status: "queued" }), { status: 202, headers: { "Content-Type": "application/json" } });
  }

  if (pathname.startsWith("/api/study/jobs/")) {
    const jobId = pathname.split("/").pop() || "";
    const job = currentJobs.find((entry) => entry.id === jobId);
    if (!job) return new Response(JSON.stringify({ error: "Job not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ job }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (pathname.startsWith("/api/modules/") && pathname.includes("/chapters/")) {
    const match = pathname.match(/^\/api\/modules\/([^/]+)\/chapters\/([^/]+)\/complete$/);
    if (match && init?.method === "POST") {
      const nextModules = currentModules.map((module) => {
        if (module.id !== match[1]) return module;
        const chapterList = module.chapters.map((chapter) => chapter.id === match[2] ? { ...chapter, completed: true } : chapter);
        return { ...module, chapters: chapterList, progress: deriveProgress(chapterList) };
      });
      writeLibrary(session.username, nextModules);
      const module = nextModules.find((item) => item.id === match[1]);
      return new Response(JSON.stringify({ module }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }

  if (pathname.startsWith("/api/modules/") && pathname.includes("/enhance")) {
    const matches = pathname.match(/^\/api\/modules\/([^/]+)\/enhance$/);
    if (matches && init?.method === "POST") {
      const nextModules = currentModules.map((module) => module.id === matches[1] ? { ...module, description: `${module.description} Updated for a stronger learning flow.` } : module);
      writeLibrary(session.username, nextModules);
      return new Response(JSON.stringify({ module: nextModules.find((module) => module.id === matches[1]) }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }

  if (pathname.startsWith("/api/modules/") && pathname.includes("/regenerate/")) {
    const matches = pathname.match(/^\/api\/modules\/([^/]+)\/regenerate\/([^/]+)$/);
    if (matches && init?.method === "POST") {
      const nextModules = currentModules.map((module) => {
        if (module.id !== matches[1]) return module;
        return { ...module, updatedAt: new Date().toISOString() } as Module;
      });
      writeLibrary(session.username, nextModules);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }

  if (pathname.startsWith("/api/modules/") && pathname.endsWith("/flashcards")) {
    const moduleId = pathname.split("/")[2];
    const module = currentModules.find((item) => item.id === moduleId);
    if (!module) return new Response(JSON.stringify({ error: "Module not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const flashcards = module.chapters.flatMap((chapter, chapterIndex) => (chapter.keyTakeaways || []).map((keyTakeaway, index) => ({
      id: `${module.id}-flashcard-${chapter.id}-${index}`,
      moduleId: module.id,
      chapterId: chapter.id,
      question: `Recall: ${keyTakeaway.split(".")[0]}`,
      answer: keyTakeaway,
      difficulty: chapterIndex % 2 === 0 ? "medium" : "hard",
    }))); 
    return new Response(JSON.stringify({ flashcards }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (pathname.startsWith("/api/modules/") && pathname.endsWith("/pre-exam")) {
    const moduleId = pathname.split("/")[2];
    const module = currentModules.find((item) => item.id === moduleId);
    if (!module) return new Response(JSON.stringify({ error: "Module not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const questions = [{ id: `${module.id}-pre-1`, question: `What is the main goal of studying ${module.topic}?`, type: "multiple_choice", options: ["Memorize everything", "Apply the concept in context", "Skip the practice step"], difficulty: "easy" }, { id: `${module.id}-pre-2`, question: `A good learning path should connect theory to a real example.`, type: "true_false", options: ["True", "False"], difficulty: "easy" }];
    return new Response(JSON.stringify({ exam: { id: `${module.id}-pre`, title: "Foundations check", description: `Quick pre-assessment for ${module.topic}`, totalQuestions: 2 }, questions }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (pathname.startsWith("/api/modules/") && pathname.endsWith("/final-exam")) {
    const moduleId = pathname.split("/")[2];
    const module = currentModules.find((item) => item.id === moduleId);
    if (!module) return new Response(JSON.stringify({ error: "Module not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const questions = [{ id: `${module.id}-final-1`, question: `How would you explain your learning from ${module.topic} in one sentence?`, type: "short_answer", options: null, difficulty: "medium" }, { id: `${module.id}-final-2`, question: `What is the strongest way to confirm understanding of a concept?`, type: "multiple_choice", options: ["Repeat the definition", "Apply it to a task", "Ignore the example"], difficulty: "medium" }];
    return new Response(JSON.stringify({ exam: { id: `${module.id}-final`, title: "Final check", description: `Final assessment for ${module.topic}`, totalQuestions: 2 }, questions }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (pathname.startsWith("/api/modules/") && pathname.endsWith("/pre-exam/submit")) {
    const moduleId = pathname.split("/")[2];
    const module = currentModules.find((item) => item.id === moduleId);
    if (!module) return new Response(JSON.stringify({ error: "Module not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const nextModules = currentModules.map((item) => item.id === moduleId ? { ...item, preExamScore: 100 } : item);
    writeLibrary(session.username, nextModules);
    return new Response(JSON.stringify({ score: 1, total: 1, percentage: 100 }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (pathname.startsWith("/api/modules/") && pathname.endsWith("/final-exam/submit")) {
    const moduleId = pathname.split("/")[2];
    const module = currentModules.find((item) => item.id === moduleId);
    if (!module) return new Response(JSON.stringify({ error: "Module not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    const nextModules = currentModules.map((item) => item.id === moduleId ? { ...item, finalScore: 100 } : item);
    writeLibrary(session.username, nextModules);
    return new Response(JSON.stringify({ score: 1, total: 1, percentage: 100 }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (pathname === "/api/ollama/status") return new Response(JSON.stringify({ connected: true, model: "local-study-model", models: ["local-study-model"], message: "Tutor is available for your account." }), { status: 200, headers: { "Content-Type": "application/json" } });

  if (pathname === "/api/tutor/chat" && init?.method === "POST") {
    // Forward tutor chat requests to the real server endpoint so Ollama can generate responses.
    return originalFetch(input, init);
  }

  return originalFetch(input, init);
}

const originalFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => enforceAccountSession(input, init)) as typeof window.fetch;

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem("theme") as "light" | "dark") || "light");
  const [session, setSession] = useState<AuthSession | null>(() => readSession());
  const [modules, setModules] = useState<Module[]>([]);
  const [selectedModule, setSelectedModule] = useState<Module | null>(null);
  const [showQuickCreate, setShowQuickCreate] = useState(false);
  const [quickTopic, setQuickTopic] = useState("");
  const [toast, setToast] = useState("");
  const [tutorContext, setTutorContext] = useState<{ moduleId?: string; chapterId?: string; chapterTitle?: string } | null>(null);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [pendingTotpUser, setPendingTotpUser] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [totpError, setTotpError] = useState("");
  // Setup modal state
  const [totpSetupOpen, setTotpSetupOpen] = useState(false);
  const [totpSetupQr, setTotpSetupQr] = useState<string | null>(null);
  const [totpSetupSecret, setTotpSetupSecret] = useState<string | null>(null);
  const [totpSetupVerifyCode, setTotpSetupVerifyCode] = useState("");

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("theme", theme); }, [theme]);
  useEffect(() => { if (!session) return; void loadModules(); }, [session?.username]);
  useEffect(() => { if (toast) { const timer = window.setTimeout(() => setToast(""), 3200); return () => window.clearTimeout(timer); } }, [toast]);

  async function loadModules() {
    if (!session) return;
    try {
      const response = await fetch("/api/modules");
      const data = await response.json();
      setModules(data.modules || []);
    } catch {
      setToast("Could not load your learning library.");
    }
  }
  function openView(next: View) { setView(next); setSelectedModule(null); }
  function handleLogin(username: string, password: string) {
    const trimmedUsername = username.trim();
    const trimmedPassword = password.trim();
    if (!trimmedUsername || !trimmedPassword) {
      setAuthError("Enter a username and password.");
      return;
    }
    const accounts = ensureAdminAccount();
    const match = accounts.find((account) => account.username.toLowerCase() === trimmedUsername.toLowerCase() && account.password === trimmedPassword);
    if (!match) { setAuthError("Incorrect username or password."); return; }
    // If the account has TOTP/2FA enabled, move to verification step
    if (match.totpEnabled) {
      setPendingTotpUser(match.username);
      setAuthError("");
      setAuthPassword("");
      return;
    }
    const nextSession: AuthSession = { username: match.username, displayName: match.name, createdAt: new Date().toISOString() };
    writeSession(nextSession);
    setSession(nextSession);
    setAuthError("");
    setAuthUsername("");
    setAuthPassword("");
  }
  function handleLogout() { writeSession(null); setSession(null); setSelectedModule(null); setView("dashboard"); }
  function goToModule(module: Module) { setSelectedModule(module); setView("modules"); }
  function openQuickCreate(topic = "") { setQuickTopic(topic); setShowQuickCreate(true); setSelectedModule(null); }
  function handleModuleUpdated(updated: Module) {
    setModules((current) => current.map((module) => module.id === updated.id ? updated : module));
    setSelectedModule(updated);
  }
  function openTutor(context: { moduleId?: string; chapterId?: string; chapterTitle?: string }) {
    setTutorContext(context);
    setSelectedModule(null);
    setView("tutor");
  }
  async function deleteModule(module: Module) {
    if (!window.confirm(`Delete “${module.title}” from your learning library? This cannot be undone.`)) return;
    try {
      const response = await fetch(`/api/modules/${module.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setModules((current) => current.filter((item) => item.id !== module.id));
      if (selectedModule?.id === module.id) {
        setSelectedModule(null);
        setView("modules");
      }
      setToast("Module deleted.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not delete module.");
    }
  }

  if (!session) {
    if (pendingTotpUser) {
      return <TotpVerifyScreen
        username={pendingTotpUser}
        totpCode={totpCode}
        totpError={totpError}
        onTotpCodeChange={setTotpCode}
        onVerify={async () => {
          const accounts = ensureAdminAccount();
          const account = accounts.find((a) => a.username === pendingTotpUser);
          if (!account || !account.totpSecret) { setTotpError("Setup for this account is missing."); return; }
          try {
            const ok = await verifyTotp(account.totpSecret, totpCode.trim());
            if (!ok) { setTotpError("Invalid code. Try again."); return; }
            const nextSession: AuthSession = { username: account.username, displayName: account.name, createdAt: new Date().toISOString() };
            writeSession(nextSession);
            setSession(nextSession);
            setPendingTotpUser(null);
            setTotpCode("");
            setTotpError("");
            setAuthUsername("");
            setAuthPassword("");
          } catch (err) {
            setTotpError("Verification error. Try again.");
          }
        }}
        onCancel={() => { setPendingTotpUser(null); setTotpCode(""); setTotpError(""); }}
      />;
    }

    return <LoginScreen
      authUsername={authUsername}
      authPassword={authPassword}
      authError={authError}
      onAuthUsernameChange={setAuthUsername}
      onAuthPasswordChange={setAuthPassword}
      onSubmit={(event) => {
        event.preventDefault();
        handleLogin(authUsername, authPassword);
      }}
      onCancel={() => {
        setAuthUsername("");
        setAuthPassword("");
        setAuthError("");
      }}
    />;
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${collapsed ? "sidebar--collapsed" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark"><Sparkles size={18} strokeWidth={2.5} /></div>
          {!collapsed && <span className="brand-name">study<span>lab</span></span>}
          <button className="icon-btn sidebar-toggle" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button>
        </div>
        <div className="sidebar-content">
          <button className={`create-btn ${collapsed ? "create-btn--collapsed" : ""}`} onClick={() => openQuickCreate()}><Plus size={18} />{!collapsed && "New study module"}</button>
          <nav className="nav-list" aria-label="Primary navigation">
            {nav.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${view === id && !selectedModule ? "is-active" : ""}`} onClick={() => openView(id)} title={collapsed ? label : undefined}><Icon size={18} /><span>{!collapsed && label}</span>{id === "modules" && modules.length > 0 && !collapsed && <small>{modules.length}</small>}</button>)}
          </nav>
          {!collapsed && <div className="nav-section-label">Workspace</div>}
          <nav className="nav-list">
            {secondaryNav.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${view === id && !selectedModule ? "is-active" : ""}`} onClick={() => openView(id)} title={collapsed ? label : undefined}><Icon size={18} /><span>{!collapsed && label}</span></button>)}
          </nav>
          {!collapsed && <div className="sidebar-bottom"><div className="upgrade-card"><div className="upgrade-icon"><Zap size={16} /></div><strong>Make every hour count.</strong><p>Build a study habit that compounds.</p><button onClick={() => setView("plans")}>View your plan <ArrowRight size={14} /></button></div><div className="user-chip"><div className="avatar"><Sparkles size={14} /></div><div><strong>{session.displayName}</strong><span>{session.username}</span></div><button className="icon-btn user-chip-btn" onClick={handleLogout} aria-label="Log out"><MoreHorizontal size={17} /></button></div></div>}
        </div>
      </aside>
      <main className={`main-content ${collapsed ? "main-content--wide" : ""}`}>
        <header className="topbar"><div className="mobile-brand"><div className="brand-mark"><Sparkles size={16} /></div><span>studylab</span></div><div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><strong>{selectedModule ? selectedModule.title : nav.concat(secondaryNav).find((item) => item.id === view)?.label || "Dashboard"}</strong></div><div className="topbar-actions"><button className="search-trigger" onClick={() => setView("explore")}><Search size={16} /><span>Search anything</span><kbd>⌘ K</kbd></button><button className="icon-btn theme-toggle" onClick={() => setTheme((value) => value === "light" ? "dark" : "light")} aria-label="Toggle theme">{theme === "light" ? <Moon size={17} /> : <Sparkles size={17} />}</button><div className="user-name-badge">{session.displayName}</div><button className="outline-btn logout-btn" onClick={handleLogout}>Log out</button></div></header>
        {selectedModule ? <ModuleDetail module={selectedModule} onBack={() => { setSelectedModule(null); setView("dashboard"); }} onRefresh={loadModules} onModuleUpdated={handleModuleUpdated} setToast={setToast} onTutor={openTutor} setView={setView} /> : <>{view === "dashboard" && <Dashboard modules={modules} onCreate={openQuickCreate} onModule={goToModule} onView={openView} />}{view === "explore" && <Explore onCreate={openQuickCreate} />}{view === "create" && <CreateModule onDone={(module) => { setModules((current) => [module, ...current]); setSelectedModule(module); setView("modules"); }} />}{view === "modules" && <Modules modules={modules} onCreate={() => setView("create")} onModule={goToModule} onDelete={deleteModule} />}        {view === "progress" && <Progress modules={modules} onCreate={openQuickCreate} />}{view === "general-chat" && <GeneralChat />}{view === "tutor" && <Tutor context={tutorContext} />}{view === "flashcards" && <Flashcards />}{view === "plans" && <Plans />}        {view === "settings" && <Settings theme={theme} setTheme={setTheme} currentUser={session} />}</>}      </main>      <nav className="mobile-nav" aria-label="Mobile navigation">
        {nav.concat(secondaryNav).map(({ id, label, icon: Icon }) => <button key={id} className={view === id && !selectedModule ? "is-active" : ""} onClick={() => openView(id)}><Icon size={17} /><span>{label === "My learning" ? "Learning" : label}</span></button>)}
      </nav>
      {showQuickCreate && <QuickCreate initialTopic={quickTopic} onClose={() => setShowQuickCreate(false)} onCreated={(module) => { setShowQuickCreate(false); setModules((current) => [module, ...current]); setSelectedModule(module); setView("modules"); }} />}
      {toast && <div className="toast"><Check size={16} />{toast}</div>}
    </div>
  );
}

function LoginScreen({
  authUsername,
  authPassword,
  authError,
  onAuthUsernameChange,
  onAuthPasswordChange,
  onSubmit,
  onCancel,
}: {
  authUsername: string;
  authPassword: string;
  authError: string;
  onAuthUsernameChange: (value: string) => void;
  onAuthPasswordChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  return <div className="auth-screen"><div className="auth-panel"><div className="brand-row auth-brand"><div className="brand-mark"><Sparkles size={18} strokeWidth={2.5} /></div><span className="brand-name">study<span>lab</span></span></div><div className="auth-header"><div className="eyebrow">PRIVATE ACCOUNT ACCESS</div><h1>Welcome back</h1><p>Log in to keep your study materials separate from every other account.</p></div><form className="auth-form" onSubmit={onSubmit}><div className="auth-field"><label>Username</label><input value={authUsername} onChange={(event) => onAuthUsernameChange(event.target.value)} placeholder="Enter username" autoComplete="off" spellCheck={false} /></div><div className="auth-field"><label>Password</label><input type="password" value={authPassword} onChange={(event) => onAuthPasswordChange(event.target.value)} placeholder="••••••••" autoComplete="new-password" /></div>{authError && <div className="auth-error">{authError}</div>}<button type="submit" className="primary-btn auth-submit">Enter workspace</button></form><button type="button" className="text-btn auth-cancel" onClick={onCancel}>Clear form</button></div></div>;
}

function TotpVerifyScreen({ username, totpCode, totpError, onTotpCodeChange, onVerify, onCancel }: { username: string; totpCode: string; totpError: string; onTotpCodeChange: (v: string) => void; onVerify: () => Promise<void> | void; onCancel: () => void }) {
  return <div className="auth-screen"><div className="auth-panel"><div className="brand-row auth-brand"><div className="brand-mark"><Sparkles size={18} strokeWidth={2.5} /></div><span className="brand-name">study<span>lab</span></span></div><div className="auth-header"><div className="eyebrow">TWO-STEP VERIFICATION</div><h1>Enter your code</h1><p>Open Microsoft Authenticator (or another TOTP app) and enter the 6-digit code for <strong>{username}</strong>.</p></div><form className="auth-form" onSubmit={(e) => { e.preventDefault(); onVerify(); }}><div className="auth-field"><label>6-digit code</label><input value={totpCode} onChange={(event) => onTotpCodeChange(event.target.value)} placeholder="000000" autoComplete="one-time-code" /></div>{totpError && <div className="auth-error">{totpError}</div>}<button type="submit" className="primary-btn auth-submit">Verify</button></form><div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 8 }}><button type="button" className="text-btn" onClick={onCancel}>Back</button></div></div></div>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: React.ReactNode; description?: string; action?: React.ReactNode }) {
  return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}

function Dashboard({ modules, onCreate, onModule, onView }: { modules: Module[]; onCreate: () => void; onModule: (module: Module) => void; onView: (view: View) => void }) {
  const active = modules[0];
  return <div className="page dashboard-page">
    <PageHeader eyebrow="Tuesday, August 18" title={<>Good morning <span className="wave">✦</span></>} description="A small step today keeps your bigger goals moving." action={<button className="outline-btn" onClick={() => onView("progress")}><TrendingUp size={16} /> View progress</button>} />
    <section className="hero-card">
      <div className="hero-copy"><div className="hero-label"><Sparkles size={14} /> YOUR NEXT DEEP DIVE</div><h2>{active ? "Keep your momentum going." : "What do you want to learn?"}</h2><p>{active ? `You’re ${active.progress}% through ${active.title}. Pick up where you left off and turn today's focus into progress.` : "Tell me a topic, a goal, or a question. I’ll turn it into a focused, research-backed learning path."}</p><button type="button" className="primary-btn" onClick={active ? () => onModule(active) : () => onCreate()}>{active ? <>Continue learning <ArrowRight size={16} /></> : <>Create your first module <ArrowRight size={16} /></>}</button></div><div className="hero-orbit"><div className="orbit orbit-one"></div><div className="orbit orbit-two"></div><div className="hero-bubble"><Brain size={34} /><span>Learn<br /><b>with intent.</b></span></div><div className="hero-dot hero-dot--one"></div><div className="hero-dot hero-dot--two"></div></div>
    </section>
    <div className="dashboard-grid">
      <section className="panel continue-panel"><div className="panel-heading"><div><div className="eyebrow">CONTINUE LEARNING</div><h3>{active ? active.title : "Your learning path starts here"}</h3></div><button type="button" className="icon-btn"><MoreHorizontal size={18} /></button></div>{active ? <div className="continue-content"><div className="module-thumb"><span>{active.topic.slice(0, 2).toUpperCase()}</span><div className="thumb-grid"></div></div><div className="continue-meta"><div className="meta-line"><span>{active.difficulty} · {active.estimatedMinutes} min</span><span className="progress-label">{active.progress}%</span></div><div className="progress-track"><div style={{ width: `${active.progress}%` }}></div></div><button type="button" className="text-btn" onClick={() => onModule(active)}>Resume chapter <ArrowRight size={15} /></button></div></div> : <EmptyInline icon={<BookOpen size={18} />} title="No modules yet" text="Create a module tailored to your next goal." onClick={() => onCreate()} />}</section>
      <section className="panel streak-panel"><div className="panel-heading"><div><div className="eyebrow">LEARNING STREAK</div><h3>Stay in rhythm</h3></div><div className="streak-flame"><Flame size={17} fill="currentColor" /></div></div><div className="streak-number">0 <span>days</span></div><div className="week-row">{["M","T","W","T","F","S","S"].map((day, index) => <div key={`${day}-${index}`} className={`day ${index === 1 ? "day--today" : ""}`}><span>{day}</span><i>{index === 1 ? <Check size={12} /> : ""}</i></div>)}</div><p className="muted-text">Complete a 15-minute session today to start your streak.</p></section>
      <section className="panel goal-panel"><div className="panel-heading"><div><div className="eyebrow">TODAY'S GOAL</div><h3>Make it count</h3></div><Target size={18} className="panel-icon" /></div><div className="goal-ring"><div><strong>0<span>/30</span></strong><small>minutes</small></div></div><button className="soft-btn" onClick={onCreate}><Plus size={15} /> Add a study session</button></section>
      <section className="panel topics-panel"><div className="panel-heading"><div><div className="eyebrow">EXPLORE NEXT</div><h3>Ideas for your curiosity</h3></div><button type="button" className="text-btn" onClick={() => onView("explore")}>See all <ArrowRight size={14} /></button></div><div className="topic-list">{topics.slice(0, 4).map((topic, index) => <button type="button" key={topic} onClick={() => onCreate()} className="topic-row"><span className={`topic-color topic-color--${index}`}></span><span>{topic}</span><ArrowRight size={15} /></button>)}</div></section>
    </div>
  </div>;
}

function EmptyInline({ icon, title, text, onClick }: { icon: React.ReactNode; title: string; text: string; onClick: () => void }) { return <div className="empty-inline"><div className="empty-icon">{icon}</div><div><strong>{title}</strong><p>{text}</p></div><button className="icon-btn" onClick={onClick}><Plus size={17} /></button></div>; }

function CreateModule({ onDone }: { onDone: (module: Module) => void }) {
  return <div className="page create-page"><PageHeader eyebrow="NEW LEARNING PATH" title="Build your next obsession." description="Start with a topic. We’ll shape the path around how you want to learn." /><CreateForm onDone={onDone} /></div>;
}

function QuickCreate({ initialTopic, onClose, onCreated }: { initialTopic: string; onClose: () => void; onCreated: (module: Module) => void }) { return <div className="modal-backdrop" onMouseDown={onClose}><div className="quick-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close icon-btn" onClick={onClose}><X size={18} /></button><div className="eyebrow">NEW LEARNING PATH</div><h2>What do you want to learn?</h2><p>Describe a topic, goal, or challenge in your own words.</p><CreateForm initialTopic={initialTopic} onDone={onCreated} compact /></div></div>; }

function CreateForm({ initialTopic = "", onDone, compact = false }: { initialTopic?: string; onDone: (module: Module) => void; compact?: boolean }) {
  const savedSettings = (() => { try { return JSON.parse(localStorage.getItem("study-settings") || "{}"); } catch { return {}; } })();
  const [topic, setTopic] = useState(initialTopic); const [goal, setGoal] = useState(savedSettings.goal || "Professional learning"); const [difficulty, setDifficulty] = useState(savedSettings.difficulty || "Intermediate"); const [style, setStyle] = useState(savedSettings.learningStyle || "Balanced"); const [studyTime, setStudyTime] = useState(savedSettings.studyTime || "30 min/day"); const [researchDepth, setResearchDepth] = useState(savedSettings.researchDepth || localStorage.getItem("research-depth") || "basic"); const [job, setJob] = useState<{ id: string; stage: string; completedStages: string[]; error?: string } | null>(null); const [loading, setLoading] = useState(false);
  const labels: Record<string, string> = { understanding: "Understanding your goal", researching: "Researching trusted sources", analyzing: "Analyzing what matters", curriculum: "Designing your curriculum", "pre-exam": "Preparing your diagnostic", chapters: "Writing your chapters", videos: "Finding relevant videos", flashcards: "Creating your flashcards", "final-exam": "Building your final exam" };
  async function submit(event: React.FormEvent) { event.preventDefault(); if (!topic.trim()) return; setLoading(true); try { const response = await fetch("/api/study/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic, goal, difficulty, style, studyTime, researchDepth }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); const interval = window.setInterval(async () => { const status = await fetch(`/api/study/jobs/${data.jobId}`).then((result) => result.json()); setJob(status.job); if (status.job.stage === "completed" && status.job.moduleId) { window.clearInterval(interval); const module = await fetch(`/api/modules/${status.job.moduleId}`).then((result) => result.json()); onDone(module.module); setLoading(false); } else if (status.job.stage === "error") { window.clearInterval(interval); setLoading(false); } }, 450); } catch (error) { setJob({ id: "error", stage: "error", completedStages: [], error: error instanceof Error ? error.message : "Unable to start generation." }); setLoading(false); } }
  return <form className={`create-card ${compact ? "create-card--compact" : ""}`} onSubmit={submit}><div className="topic-input-wrap"><Sparkles size={20} /><input autoFocus={!compact} value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="e.g. Prepare me for AZ-104..." /></div><div className="suggestion-row"><span>Try</span>{["Microsoft Intune", "Python for work", "Network troubleshooting"].map((item) => <button type="button" key={item} onClick={() => setTopic(item)}>{item}</button>)}</div><div className="option-grid"><Option label="Learning goal" value={goal} options={["General learning", "Professional learning", "Certification", "Interview preparation", "Academic"]} onChange={setGoal} /><Option label="Difficulty" value={difficulty} options={["Auto", "Beginner", "Intermediate", "Advanced", "Expert"]} onChange={setDifficulty} /><Option label="Learning style" value={style} options={["Balanced", "Theory heavy", "Practical", "Exam focused", "Project based"]} onChange={setStyle} /><Option label="Time available" value={studyTime} options={["15 min/day", "30 min/day", "1 hour/day", "2 hours/day"]} onChange={setStudyTime} /></div><div className="research-choice"><div><strong>Research depth</strong><p>Use verified web sources to ground your experience.</p></div><div className="segmented">{["basic", "advanced", "deep"].map((item) => <button type="button" key={item} className={researchDepth === item ? "selected" : ""} onClick={() => setResearchDepth(item)}>{item === "basic" ? "Quick" : item === "advanced" ? "Thorough" : "Deep"}</button>)}</div></div>{job && loading && <div className="generation-box"><div className="generation-head"><div><span className="eyebrow">BUILDING YOUR EXPERIENCE</span><strong>{labels[job.stage] || "Preparing your learning path"}</strong></div><span className="loading-orb"><Sparkles size={14} /></span></div><div className="generation-progress"><div style={{ width: `${Math.min(96, Math.max(7, (job.completedStages.length / 9) * 100))}%` }}></div></div><div className="stage-pills">{Object.keys(labels).slice(0, 6).map((stage) => <span key={stage} className={job.completedStages.includes(stage) ? "done" : job.stage === stage ? "current" : ""}>{job.completedStages.includes(stage) && <Check size={11} />}{labels[stage]}</span>)}</div></div>}{job?.error && <div className="error-box"><CircleHelp size={17} /><span>{job.error}</span></div>}<button className="primary-btn create-submit" disabled={loading || topic.trim().length < 3}>{loading ? <>Creating your path <span className="button-spinner"></span></> : <>Generate study module <ArrowRight size={16} /></>}</button><p className="form-footnote"><span className="status-dot"></span> Your tutor will use your module context, progress, and sources.</p></form>;
}

function Option({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) { return <label className="select-field"><span>{label}</span><div><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((item) => <option key={item}>{item}</option>)}</select><ChevronDown size={15} /></div></label>; }

function Explore({ onCreate }: { onCreate: (topic: string) => void }) { const [search, setSearch] = useState(""); const filtered = topics.filter((topic) => topic.toLowerCase().includes(search.toLowerCase())); return <div className="page"><PageHeader eyebrow="EXPLORE" title="Follow your curiosity." description="Browse a starting point, or describe something entirely new." action={<button className="primary-btn" onClick={() => onCreate("")}><Plus size={16} /> New topic</button>} /><div className="explore-search"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search subjects, skills, or goals..." /><kbd>⌘ K</kbd></div><div className="explore-layout"><section><div className="section-title"><h3>Popular starting points</h3><span>Updated weekly</span></div><div className="explore-grid">{filtered.map((topic, index) => <button className="explore-card" key={topic} onClick={() => onCreate(topic)}><div className={`explore-art explore-art--${index}`}><span>{topic.split(" ").map((word) => word[0]).join("").slice(0, 3)}</span></div><div><span className="card-kicker">{["IT & systems", "Programming", "Cloud & infra", "Career skills", "Mathematics", "Product"][index]}</span><h3>{topic}</h3><p>Build confidence through a focused learning path.</p></div><ArrowRight size={17} /></button>)}</div></section><aside className="explore-aside panel"><div className="eyebrow">HOW IT WORKS</div><h3>Learn like you mean it.</h3><div className="how-row"><span>01</span><div><strong>Tell us what matters</strong><p>Any topic, any starting point, in your own words.</p></div></div><div className="how-row"><span>02</span><div><strong>Get a path with a point of view</strong><p>Research, structure, and practice in one place.</p></div></div><div className="how-row"><span>03</span><div><strong>Make progress you can feel</strong><p>Review, reflect, and adapt as you go.</p></div></div></aside></div></div>; }

function Modules({ modules, onCreate, onModule, onDelete }: { modules: Module[]; onCreate: () => void; onModule: (module: Module) => void; onDelete: (module: Module) => void }) { return <div className="page"><PageHeader eyebrow="MY LEARNING" title="Your learning library." description={`${modules.length} ${modules.length === 1 ? "path" : "paths"} shaped around your goals.`} action={<button className="primary-btn" onClick={onCreate}><Plus size={16} /> New module</button>} />{modules.length ? <div className="library-grid">{modules.map((module, index) => <article className="library-card" key={module.id}><button className="library-card-open" onClick={() => onModule(module)}><div className={`library-art library-art--${index % 4}`}><span>{module.topic.slice(0, 2).toUpperCase()}</span><div className="art-lines"></div></div><div className="library-card-body"><div className="meta-line"><span>{module.difficulty} · {module.estimatedMinutes} min</span><span>{module.progress}%</span></div><h3>{module.title}</h3><p>{module.description}</p><div className="progress-track"><div style={{ width: `${module.progress}%` }}></div></div><div className="library-footer"><span>{module.chapters.length} chapters</span><ArrowRight size={16} /></div></div></button><button type="button" className="library-delete" aria-label={`Delete ${module.title}`} title="Delete module" onClick={() => onDelete(module)}><Trash2 size={15} /></button></article>)}</div> : <div className="large-empty"><div className="empty-orb"><BookOpen size={28} /></div><h2>Nothing here yet.</h2><p>Your first learning path is one good question away.</p><button className="primary-btn" onClick={onCreate}>Create a module <ArrowRight size={16} /></button></div>}</div>; }

function chapterLesson(module: Module, chapter: Module["chapters"][number], index: number) {
  const objective = module.objectives[index % module.objectives.length] || "Build a practical foundation";
  const title = chapter.title.toLowerCase();
  const content = (chapter as any)?.content || {};
  const intro = content.intro || `${chapter.description} This chapter gives you the core context before moving into application.`;
  const concept = content.concept || `The central idea in this chapter is ${title}. Focus on how it connects to the broader goal of ${module.topic}.`;
  const workedExample = content.workedExample || chapter.example || `Apply ${title} to one real situation from your work, studies, or daily life.`;
  const exercise = content.exercise || content.practicalExercise || chapter.practicePrompt || `Without looking back, explain ${title} in your own words and describe one real example where it matters.`;
  const recap = content.recap || `Recap: understand the idea, connect it to a real example, then apply it intentionally before moving on.`;
  const structuredMaterial = [
    intro,
    concept,
    ...((Array.isArray(content.coreConcepts) ? content.coreConcepts : []).map((item: any) => `${item.title}: ${item.explanation}`)),
    ...((Array.isArray(content.stepByStep) ? content.stepByStep : []).map((item: string, itemIndex: number) => `Step ${itemIndex + 1}: ${item}`)),
    ...((Array.isArray(content.realWorldExamples) ? content.realWorldExamples : [])),
    ...((Array.isArray(content.practicalExamples) ? content.practicalExamples : [])),
    ...((Array.isArray(content.technicalExamples) ? content.technicalExamples : [])),
    exercise,
    recap,
  ].filter(Boolean).join("\n\n");
  const detailedText = String(content.detailedExplanation || chapter.lesson || "");
  const reading = detailedText.trim().length >= 1800 ? detailedText : `${detailedText}\n\n${structuredMaterial}`;
  return {
    intro,
    concept,
    reading: reading.trim() || `${chapter.description} Use this chapter to build a clear mental model of ${title}, then connect it to the wider goal of ${module.topic}.`,
    takeaways: chapter.keyTakeaways?.length ? chapter.keyTakeaways : [
      `Read the chapter description and explain ${title} in one sentence.`,
      `Connect this idea to the objective: “${objective}”.`,
      `Write one example of how you would use it in a real situation.`,
    ],
    example: workedExample,
    exercise,
    check: chapter.practicePrompt || `Without looking back, how would you explain ${title} to a teammate, and what is one decision it would help them make?`,
    recap,
    why: String(content.why || `This chapter gives you the knowledge and judgment needed to use ${title} confidently in the wider topic of ${module.topic}.`),
    learningObjectives: Array.isArray(content.learningObjectives) ? content.learningObjectives : [],
    prerequisites: Array.isArray(content.prerequisites) ? content.prerequisites : [],
    coreConcepts: Array.isArray(content.coreConcepts) ? content.coreConcepts : [],
    steps: Array.isArray(content.stepByStep) ? content.stepByStep : [],
    realWorldExamples: Array.isArray(content.realWorldExamples) ? content.realWorldExamples : [],
    practicalExamples: Array.isArray(content.practicalExamples) ? content.practicalExamples : [],
    technicalExamples: Array.isArray(content.technicalExamples) ? content.technicalExamples : [],
    commonMistakes: Array.isArray(content.commonMistakes) ? content.commonMistakes : [],
    troubleshooting: Array.isArray(content.troubleshooting) ? content.troubleshooting : [],
    bestPractices: Array.isArray(content.bestPractices) ? content.bestPractices : [],
    importantTerms: Array.isArray(content.importantTerms) ? content.importantTerms : [],
    quiz: Array.isArray(content.quickQuiz) ? content.quickQuiz : [],
    scenario: content.scenarioExercise || "",
    visualExplanation: String(content.visualExplanation || ""),
    furtherReading: Array.isArray(content.furtherReading) ? content.furtherReading : [],
  };
}

function getYoutubeVideoId(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtu.be")) return parsed.pathname.replace("/", "") || null;
    if (parsed.searchParams.get("v")) return parsed.searchParams.get("v");
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    return pathParts[pathParts.length - 1] || null;
  } catch {
    return null;
  }
}

function getYoutubeEmbedUrl(url: string) {
  const id = getYoutubeVideoId(url);
  return id ? `https://www.youtube.com/embed/${id}` : null;
}

function LessonSection({ eyebrow, title, children, open = false, className = "" }: { eyebrow: string; title: string; children: React.ReactNode; open?: boolean; className?: string }) {
  return <details className={`lesson-section ${className}`} open={open}>
    <summary><span><span className="eyebrow">{eyebrow}</span><strong>{title}</strong></span><ChevronDown size={17} /></summary>
    <div className="lesson-section-body">{children}</div>
  </details>;
}

function ModuleDetail({ module, onBack, onRefresh, onModuleUpdated, setToast, onTutor, setView }: { module: Module; onBack: () => void; onRefresh: () => void; onModuleUpdated: (module: Module) => void; setToast: (text: string) => void; onTutor: (ctx: { moduleId?: string; chapterId?: string; chapterTitle?: string }) => void; setView: (view: View) => void }) {
  const [activeChapter, setActiveChapter] = useState(module.chapters.find((chapter) => !chapter.completed) || module.chapters[0]);
  const [selectedVideoUrl, setSelectedVideoUrl] = useState<string | null>(null);
  const [showPreExam, setShowPreExam] = useState(false);
  useEffect(() => { setSelectedVideoUrl(null); }, [module.id, activeChapter.id]);
  const [preExam, setPreExam] = useState<any | null>(null);
  const [showFinalExam, setShowFinalExam] = useState(false);
  const [finalExam, setFinalExam] = useState<any | null>(null);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [finalAnswers, setFinalAnswers] = useState<Record<string, any>>({});
  const [enhancing, setEnhancing] = useState(false);
  const activeIndex = module.chapters.indexOf(activeChapter);
  const lesson = chapterLesson(module, activeChapter, activeIndex);
  const chapterObjectives = module.objectives.length > 0
    ? [module.objectives[activeIndex % module.objectives.length], ...module.objectives.filter((objective) => objective !== module.objectives[activeIndex % module.objectives.length]).slice(0, 2)]
    : ["Build a practical foundation", "Apply the core ideas"];
  async function complete() {
    const response = await fetch(`/api/modules/${module.id}/chapters/${activeChapter.id}/complete`, { method: "POST" });
    const data = await response.json();
    if (data.module) {
      onModuleUpdated(data.module);
      onRefresh();
      setToast("Chapter marked complete.");
      const next = data.module.chapters[data.module.chapters.findIndex((chapter: Module["chapters"][number]) => chapter.id === activeChapter.id) + 1];
      if (next) setActiveChapter(next);
    }
  }
  async function openPreExam() {
    try {
      setShowPreExam(true);
      const res = await fetch(`/api/modules/${module.id}/pre-exam`);
      if (!res.ok) throw new Error('No pre-exam');
      const data = await res.json();
      setPreExam(data);
    } catch (err) {
      setShowPreExam(false);
      setToast('Pre-exam is not available yet.');
    }
  }
  async function openFinalExam() {
    try {
      setShowFinalExam(true);
      const res = await fetch(`/api/modules/${module.id}/final-exam`);
      if (!res.ok) throw new Error('No final exam');
      const data = await res.json();
      setFinalExam(data);
    } catch (err) {
      setShowFinalExam(false);
      setToast('Final exam is not available yet.');
    }
  }
  function setAnswer(questionId: string, value: any) { setAnswers((cur) => ({ ...cur, [questionId]: value })); }
  function setFinalAnswer(questionId: string, value: any) { setFinalAnswers((cur) => ({ ...cur, [questionId]: value })); }
  async function submitPreExam() {
    const payload = { answers: Object.keys(answers).map((questionId) => ({ questionId, answer: answers[questionId] })) };
    const res = await fetch(`/api/modules/${module.id}/pre-exam/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    setShowPreExam(false);
    setToast(`Pre-exam complete — score ${(data.score * 100).toFixed(0)}%`);
  }
  async function submitFinalExam() {
    const payload = { answers: Object.keys(finalAnswers).map((questionId) => ({ questionId, answer: finalAnswers[questionId] })) };
    const res = await fetch(`/api/modules/${module.id}/final-exam/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    setShowFinalExam(false);
    setToast(`Final exam complete — score ${(data.score * 100).toFixed(0)}%`);
  }
  async function enhanceCourse() {
    setEnhancing(true);
    setToast("Enhancing chapters and rebuilding study tools...");
    try {
      const enhance = await fetch(`/api/modules/${module.id}/enhance`, { method: "POST" });
      const enhanceData = await enhance.json();
      if (!enhance.ok) throw new Error(enhanceData.error || "Chapter enhancement failed");
      for (const [endpoint, label] of [["videos", "videos"], ["flashcards", "flashcards"], ["pre-exam", "pre-exam"], ["final-exam", "final exam"]] as const) {
        setToast(`Rebuilding ${label}...`);
        const response = await fetch(`/api/modules/${module.id}/regenerate/${endpoint}`, { method: "POST" });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `${label} rebuild failed`);
        }
      }
      const updated = await fetch(`/api/modules/${module.id}`).then((response) => response.json());
      if (updated.module) onModuleUpdated(updated.module);
      setToast("Complete course enhanced: lessons, videos, cards, and exams are ready.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Course enhancement failed.");
    } finally {
      setEnhancing(false);
    }
  }
  return <div className="page module-page">
    <div className="module-enhance-bar"><div><strong>Course quality pass</strong><span>Upgrade every chapter, then rebuild videos, flashcards, and exams from the finished lessons.</span></div><button className="primary-btn" onClick={enhanceCourse} disabled={enhancing}><Sparkles size={15} /> {enhancing ? "Enhancing course..." : "Enhance complete course"}</button></div>
    <button className="back-link" onClick={onBack}><ChevronLeft size={16} /> Back to dashboard</button>
    <div className="module-hero"><div><div className="eyebrow">LEARNING PATH · {module.difficulty.toUpperCase()}</div><h1>{module.title}</h1><p>{module.description}</p><div className="module-meta"><span><Clock3 size={15} /> {module.estimatedMinutes} min total</span><span><Layers3 size={15} /> {module.chapters.length} chapters</span><span><Sparkles size={15} /> {module.goal}</span></div></div><div className="module-progress-card"><div className="progress-ring large" style={{ background: `conic-gradient(#fff ${module.progress * 3.6}deg, rgba(255,255,255,.25) 0)` }}><strong>{module.progress}<span>%</span></strong></div><span>path complete</span></div></div><div className="module-actions-row"><button className="soft-btn" onClick={onRefresh}><ChevronRight size={14} /> Refresh</button><button className="outline-btn" onClick={async () => { setToast('Regenerating videos...'); try { const res = await fetch(`/api/modules/${module.id}/regenerate/videos`, { method: 'POST' }); if (res.ok) { const updated = await fetch(`/api/modules/${module.id}`).then(r => r.json()); onModuleUpdated(updated.module); setToast('Videos regenerated.'); } else { const err = await res.json(); setToast(err.error || 'Failed to regenerate videos'); } } catch { setToast('Failed to regenerate videos'); } }}>Regenerate videos</button><button className="outline-btn" onClick={async () => { setToast('Regenerating flashcards...'); try { const res = await fetch(`/api/modules/${module.id}/regenerate/flashcards`, { method: 'POST' }); if (res.ok) { setToast('Flashcards regenerated.'); } else { const err = await res.json(); setToast(err.error || 'Failed to regenerate flashcards'); } } catch { setToast('Failed to regenerate flashcards'); } }}>Regenerate flashcards</button><button className="outline-btn" onClick={async () => { setToast('Regenerating pre-exam...'); try { const res = await fetch(`/api/modules/${module.id}/regenerate/pre-exam`, { method: 'POST' }); if (res.ok) { setToast('Pre-exam regenerated.'); } else { const err = await res.json(); setToast(err.error || 'Failed to regenerate pre-exam'); } } catch { setToast('Failed to regenerate pre-exam'); } }}>Regenerate pre-exam</button><button className="outline-btn" onClick={async () => { setToast('Regenerating final exam...'); try { const res = await fetch(`/api/modules/${module.id}/regenerate/final-exam`, { method: 'POST' }); if (res.ok) { setToast('Final exam regenerated.'); } else { const err = await res.json(); setToast(err.error || 'Failed to regenerate final exam'); } } catch { setToast('Failed to regenerate final exam'); } }}>Regenerate final exam</button></div>
    <div className="module-layout">
      <aside className="chapter-nav panel"><div className="eyebrow">YOUR CURRICULUM</div><div className="chapter-list">{module.chapters.map((chapter, index) => <button type="button" key={chapter.id} className={`chapter-nav-row ${activeChapter.id === chapter.id ? "active" : ""}`} onClick={() => setActiveChapter(chapter)}><span className={`chapter-num ${chapter.completed ? "completed" : ""}`}>{chapter.completed ? <Check size={13} /> : String(index + 1).padStart(2, "0")}</span><span><strong>{chapter.title}</strong><small>{chapter.minutes} min</small></span>{activeChapter.id === chapter.id && <ChevronRight size={15} />}</button>)}</div><button type="button" className="soft-btn full-btn" onClick={openPreExam}><Target size={15} /> Take diagnostic</button><button type="button" className="outline-btn full-btn" onClick={openFinalExam}><GraduationCap size={15} /> Take final exam</button></aside>
      <article className="chapter-content">
        <div className="eyebrow">CHAPTER {String(activeIndex + 1).padStart(2, "0")} · {activeChapter.minutes} MIN</div>
        <h2>{activeChapter.title}</h2>
        <p className="lead">{activeChapter.description}</p>
        <div className="knowledge-strip">
          <div><strong>{lesson.coreConcepts.length || 1}</strong><span>core concepts</span></div>
          <div><strong>{lesson.steps.length || 1}</strong><span>application steps</span></div>
          <div><strong>{lesson.quiz.length || 1}</strong><span>knowledge checks</span></div>
          <div><strong>{lesson.importantTerms.length || 0}</strong><span>key terms</span></div>
        </div>
        <section className="lesson-card">
          <div className="lesson-heading"><div><span className="eyebrow">STUDY THIS CHAPTER</span><h3>Build the idea, then use it</h3></div><span className="lesson-time"><Clock3 size={14} /> {activeChapter.minutes} min</span></div>
           <LessonSection eyebrow="START HERE" title="Chapter overview" open>
              <div className="lesson-reading"><span className="eyebrow">WHY THIS MATTERS</span><p>{lesson.why}</p></div>
             <div className="lesson-reading"><span className="eyebrow">INTRO</span><p>{lesson.intro}</p></div>
             <div className="lesson-reading"><span className="eyebrow">CONCEPT</span><p>{lesson.concept}</p></div>
              {lesson.prerequisites.length > 0 && <div className="lesson-core"><span className="eyebrow">BEFORE YOU BEGIN</span>{lesson.prerequisites.map((item: string) => <div className="lesson-step" key={item}><Check size={15} /><p>{item}</p></div>)}</div>}
              {lesson.learningObjectives.length > 0 && <div className="lesson-core"><span className="eyebrow">BY THE END, YOU CAN</span>{lesson.learningObjectives.map((item: string) => <div className="lesson-step" key={item}><Check size={15} /><p>{item}</p></div>)}</div>}
             <div className="lesson-core"><span className="eyebrow">KEY TAKEAWAYS</span>{lesson.takeaways.map((takeaway, takeawayIndex) => <div className="lesson-step" key={takeaway}><span>{String(takeawayIndex + 1).padStart(2, "0")}</span><p>{takeaway}</p></div>)}</div>
           </LessonSection>
           <LessonSection eyebrow="DEEP DIVE" title="Read the full lesson">
             <div className="lesson-reading lesson-reading--long">{lesson.reading.split(/\n{2,}/).map((paragraph: string, paragraphIndex: number) => <p key={paragraphIndex}>{paragraph}</p>)}</div>
           </LessonSection>
           {lesson.coreConcepts.length > 0 && <LessonSection eyebrow="FOUNDATIONS" title="Core concepts"><div className="lesson-core">{lesson.coreConcepts.map((concept: any, conceptIndex: number) => <div className="lesson-concept-row" key={`${concept.title}-${conceptIndex}`}><strong>{concept.title}</strong><p>{concept.explanation}</p></div>)}</div></LessonSection>}
           {lesson.steps.length > 0 && <LessonSection eyebrow="APPLICATION" title="How to apply it"><div className="lesson-core">{lesson.steps.map((step: string, stepIndex: number) => <div className="lesson-step" key={`${step}-${stepIndex}`}><span>{String(stepIndex + 1).padStart(2, "0")}</span><p>{step}</p></div>)}</div></LessonSection>}
           <LessonSection eyebrow="PRACTICE" title="Examples and exercises">
             <div className="lesson-example"><span className="eyebrow">WORKED EXAMPLE</span><p>{lesson.example}</p></div>
             {lesson.realWorldExamples.length > 0 && <div className="lesson-example"><span className="eyebrow">REAL-WORLD APPLICATIONS</span>{lesson.realWorldExamples.map((example: string, exampleIndex: number) => <p key={`${example}-${exampleIndex}`}>{example}</p>)}</div>}
              {lesson.practicalExamples.length > 0 && <div className="lesson-example"><span className="eyebrow">PRACTICAL EXAMPLES</span>{lesson.practicalExamples.map((example: string, exampleIndex: number) => <p key={`practical-${exampleIndex}`}>{example}</p>)}</div>}
              {lesson.technicalExamples.length > 0 && <div className="lesson-example"><span className="eyebrow">TECHNICAL EXAMPLES</span>{lesson.technicalExamples.map((example: string, exampleIndex: number) => <p key={`technical-${exampleIndex}`}>{example}</p>)}</div>}
             <div className="lesson-check"><div className="concept-icon"><CircleHelp size={17} /></div><div><span className="eyebrow">EXERCISE</span><p>{lesson.exercise}</p></div></div>
             {lesson.scenario && <div className="lesson-check"><div className="concept-icon"><Target size={17} /></div><div><span className="eyebrow">SCENARIO PRACTICE</span><p>{lesson.scenario}</p></div></div>}
           </LessonSection>
            {lesson.bestPractices.length > 0 && <LessonSection eyebrow="FIELD NOTES" title="Best practices"><div className="lesson-core">{lesson.bestPractices.map((practice: string, practiceIndex: number) => <div className="lesson-step" key={`practice-${practiceIndex}`}><Check size={15} /><p>{practice}</p></div>)}</div></LessonSection>}
           {lesson.importantTerms.length > 0 && <LessonSection eyebrow="REFERENCE" title="Important terms"><div className="lesson-core">{lesson.importantTerms.map((term: any, termIndex: number) => <div className="lesson-concept-row" key={`${term.term}-${termIndex}`}><strong>{term.term}</strong><p>{term.definition}</p></div>)}</div></LessonSection>}
           {(lesson.commonMistakes.length > 0 || lesson.troubleshooting.length > 0) && <LessonSection eyebrow="TROUBLESHOOTING" title="Avoid common errors"><div className="lesson-example">{lesson.commonMistakes.map((mistake: string, mistakeIndex: number) => <p key={`mistake-${mistakeIndex}`}><strong>Common mistake:</strong> {mistake}</p>)}{lesson.troubleshooting.map((tip: string, tipIndex: number) => <p key={`troubleshoot-${tipIndex}`}><strong>When stuck:</strong> {tip}</p>)}</div></LessonSection>}
           <LessonSection eyebrow="WRAP UP" title="Recap and knowledge check">
             <div className="lesson-example"><span className="eyebrow">RECAP</span><p>{lesson.recap}</p></div>
             {lesson.quiz.length > 0 && <div className="lesson-quiz"><span className="eyebrow">KNOWLEDGE CHECK</span>{lesson.quiz.map((question: any, questionIndex: number) => <div className="quiz-question" key={question.id || questionIndex}><strong>{questionIndex + 1}. {question.question}</strong>{Array.isArray(question.options) && <ul>{question.options.map((option: string) => <li key={option}>{option}</li>)}</ul>}<small>Answer: {String(question.correctAnswer ?? "Review the explanation above.")}{question.explanation ? ` — ${question.explanation}` : ""}</small></div>)}</div>}
           </LessonSection>
            {lesson.visualExplanation && <LessonSection eyebrow="MENTAL MODEL" title="Visualize the idea"><div className="lesson-reading"><p>{lesson.visualExplanation}</p></div></LessonSection>}
            {lesson.furtherReading.length > 0 && <LessonSection eyebrow="KEEP GOING" title="Further reading"><div className="lesson-core">{lesson.furtherReading.map((reading: any, readingIndex: number) => <a className="source-strip" key={`reading-${readingIndex}`} href={reading.url} target="_blank" rel="noreferrer"><span>{reading.title}</span><ArrowRight size={14} /></a>)}</div></LessonSection>}
        </section>
        <div className="concept-block"><div className="concept-icon"><Sparkles size={17} /></div><div><span className="eyebrow">WHY THIS MATTERS</span><p>Understanding this layer gives you a reliable mental model for the decisions that come next. Start with the principle, then test it in a real situation.</p></div></div>
        <h3>What you’ll learn</h3><ul className="objective-list">{chapterObjectives.map((objective) => <li key={objective}><Check size={16} />{objective}</li>)}</ul>
        <div className="chapter-actions"><button type="button" className="outline-btn" onClick={() => onTutor({ moduleId: module.id, chapterId: activeChapter.id, chapterTitle: activeChapter.title })}><Bot size={16} /> Ask tutor</button><button type="button" className="outline-btn" onClick={async () => { setToast('Regenerating chapter...'); try { const res = await fetch(`/api/modules/${module.id}/regenerate/chapter/${activeChapter.id}`, { method: 'POST' }); if (res.ok) { const updated = await fetch(`/api/modules/${module.id}`).then(r => r.json()); onModuleUpdated(updated.module); setToast('Chapter regenerated.'); } else { const err = await res.json(); setToast(err.error || 'Failed to regenerate chapter'); } } catch { setToast('Failed to regenerate chapter'); } }}><Sparkles size={16} /> Regenerate chapter</button><button type="button" className="primary-btn" onClick={complete}><Check size={16} /> Mark chapter complete</button></div>
         {module.videos && module.videos.length > 0 && (() => {
             const youtubeVideos = module.videos.filter((video) => getYoutubeEmbedUrl(video.url) && ((video as any).chapterId === activeChapter.id || video.title.toLowerCase().includes(activeChapter.title.toLowerCase())));
             const displayVideo = youtubeVideos.find((video) => video.url === selectedVideoUrl) || youtubeVideos[0];
            const embedUrl = displayVideo ? getYoutubeEmbedUrl(displayVideo.url) : null;
            if (embedUrl) {
               return <div className="video-strip"><div><div className="eyebrow">CHAPTER VIDEO</div><p>A focused video selected to reinforce this chapter.</p></div><div className="video-embed"><iframe title={displayVideo.title} src={embedUrl} frameBorder={0} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen style={{ width: '100%', height: '360px' }}></iframe><div className="video-meta"><strong>{displayVideo.title}</strong><small>{displayVideo.domain}</small></div></div>{youtubeVideos.length > 1 && <div className="video-list">{youtubeVideos.map((video) => <button type="button" key={video.url} className={`video-item ${displayVideo.url === video.url ? "is-selected" : ""}`} onClick={() => setSelectedVideoUrl(video.url)}><span><Play size={13} />{video.title}</span><ArrowRight size={14} /></button>)}</div>}</div>;
            }
             return null;
          })()}
        {module.sources.length > 0 && <div className="source-strip"><div className="eyebrow">GROUNDED IN RESEARCH</div>{module.sources.slice(0, 3).map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer"><span>{source.domain || source.title}</span><ArrowRight size={14} /></a>)}</div>}

                {showPreExam && preExam && <div className="modal-backdrop" onMouseDown={() => setShowPreExam(false)}><div className="exam-modal" onMouseDown={(e) => e.stopPropagation()}><button className="modal-close icon-btn" onClick={() => setShowPreExam(false)}><X size={18} /></button><h3>{preExam.exam.title}</h3><p>{preExam.exam.description}</p><div className="exam-questions">{preExam.questions.map((q: any, idx: number) => <div key={q.id} className="exam-question"><strong>{idx + 1}. {q.question}</strong>{q.type === 'multiple_choice' && q.options && q.options.map((opt: any) => <div key={opt}><label><input type="radio" name={q.id} onChange={() => setAnswer(q.id, opt)} /> {opt}</label></div>)}{q.type === 'true_false' && <div><label><input type="radio" name={q.id} onChange={() => setAnswer(q.id, true)} /> True</label><label><input type="radio" name={q.id} onChange={() => setAnswer(q.id, false)} /> False</label></div>}{q.type === 'short_answer' && <div><input className="short-answer" onChange={(e) => setAnswer(q.id, e.target.value)} /></div>}</div>)}</div><div className="exam-actions"><button className="outline-btn" onClick={() => setShowPreExam(false)}>Cancel</button><button className="primary-btn" onClick={submitPreExam}>Submit</button></div></div></div>}
                {showFinalExam && finalExam && <div className="modal-backdrop" onMouseDown={() => setShowFinalExam(false)}><div className="exam-modal final-exam-modal" onMouseDown={(e) => e.stopPropagation()}><button className="modal-close icon-btn" onClick={() => setShowFinalExam(false)} aria-label="Close final exam"><X size={18} /></button><div className="exam-kicker"><GraduationCap size={16} /> FINAL ASSESSMENT</div><div className="exam-header"><div><h3>{finalExam.exam.title}</h3><p>{finalExam.exam.description}</p></div><span className="exam-count">{finalExam.questions.length} questions</span></div><div className="exam-guidance"><span>Take your time</span><span>Choose the best answer</span><span>Submit when you’re ready</span></div><div className="exam-questions">{finalExam.questions.map((q: any, idx: number) => <div key={q.id} className="exam-question"><div className="exam-question-heading"><span className="exam-number">{String(idx + 1).padStart(2, "0")}</span><strong>{q.question}</strong></div>{q.type === 'multiple_choice' && q.options && <div className="exam-options">{q.options.map((opt: any) => <label key={opt} className="exam-option"><input type="radio" name={q.id} onChange={() => setFinalAnswer(q.id, opt)} /><span>{opt}</span></label>)}</div>}{q.type === 'true_false' && <div className="exam-options exam-options--split"><label className="exam-option"><input type="radio" name={q.id} onChange={() => setFinalAnswer(q.id, true)} /><span>True</span></label><label className="exam-option"><input type="radio" name={q.id} onChange={() => setFinalAnswer(q.id, false)} /><span>False</span></label></div>}{q.type === 'short_answer' && <input className="short-answer" placeholder="Write your answer here..." onChange={(e) => setFinalAnswer(q.id, e.target.value)} />}</div>)}</div><div className="exam-actions"><button className="outline-btn" onClick={() => setShowFinalExam(false)}>Exit exam</button><button className="primary-btn" onClick={submitFinalExam}><Check size={16} /> Submit final exam</button></div></div></div>}
              </article>
            </div>
          </div>;
}

function Progress({ modules, onCreate }: { modules: Module[]; onCreate: (topic?: string) => void }) { const completed = modules.reduce((sum, module) => sum + module.chapters.filter((chapter) => chapter.completed).length, 0); const total = modules.reduce((sum, module) => sum + module.chapters.length, 0); const overall = total ? Math.round((completed / total) * 100) : 0; return <div className="page"><PageHeader eyebrow="PROGRESS" title="See your momentum." description="The goal isn’t perfect recall. It’s a little more clarity than yesterday." action={<button className="primary-btn" onClick={() => onCreate()}><Plus size={16} /> Start learning</button>} /><div className="stats-row"><Stat icon={<TrendingUp size={18} />} label="Overall progress" value={`${overall}%`} tone="lavender" /><Stat icon={<BookOpen size={18} />} label="Modules started" value={String(modules.length)} tone="mint" /><Stat icon={<Target size={18} />} label="Chapters complete" value={String(completed)} tone="peach" /><Stat icon={<Flame size={18} />} label="Current streak" value={completed ? "1 day" : "0 days"} tone="yellow" /></div><div className="progress-layout"><section className="panel insight-panel"><div className="panel-heading"><div><div className="eyebrow">LEARNING MOMENTUM</div><h3>{modules.length ? "Your progress by learning path." : "Your progress will appear here."}</h3></div><span className="soft-badge">{overall}% complete</span></div>{modules.length ? <div className="progress-module-list">{modules.map((module) => <div className="progress-module-row" key={module.id}><div className="progress-module-top"><strong>{module.title}</strong><span>{module.progress}%</span></div><div className="progress-track"><div style={{ width: `${module.progress}%` }}></div></div><small>{module.chapters.filter((chapter) => chapter.completed).length} of {module.chapters.length} chapters complete</small></div>)}</div> : <div className="progress-empty"><div className="empty-orb"><TrendingUp size={24} /></div><p>Complete chapters inside a module to see real progress here.</p><button className="text-btn" onClick={() => onCreate()}>Create your first module <ArrowRight size={14} /></button></div>}</section><section className="panel weak-panel"><div className="eyebrow">FOCUS AREAS</div><h3>{modules.length ? "Keep building your signal." : "We’ll surface weak spots here."}</h3><p>{modules.length ? "Your next best action is to finish the next open chapter. Exams will add targeted weak-area recommendations here." : "Once you take a diagnostic or final exam, Study Lab will turn missed concepts into a short, targeted review."}</p><button className="text-btn" onClick={() => onCreate()}>Start a focused session <ArrowRight size={14} /></button></section></div><section className="panel milestones"><div className="panel-heading"><div><div className="eyebrow">MILESTONES</div><h3>Small wins, stacked up.</h3></div><Trophy size={18} className="panel-icon" /></div><div className="milestone-row"><Milestone icon={<Sparkles size={17} />} title="First module" text="Create your first learning path" done={modules.length > 0} /><Milestone icon={<Check size={17} />} title="First chapter" text="Complete a focused lesson" done={completed > 0} /><Milestone icon={<Flame size={17} />} title="7 day rhythm" text="Study for seven days in a row" done={false} /></div></section></div>; }
function Stat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone: string }) { return <div className={`stat-card stat-card--${tone}`}><div className="stat-icon">{icon}</div><span>{label}</span><strong>{value}</strong></div>; }
function Milestone({ icon, title, text, done }: { icon: React.ReactNode; title: string; text: string; done: boolean }) { return <div className={`milestone ${done ? "done" : ""}`}><div className="milestone-icon">{done ? <Check size={17} /> : icon}</div><div><strong>{title}</strong><p>{done ? "Unlocked" : text}</p></div>{done && <span className="unlocked">Unlocked</span>}</div>; }

function renderMarkdownToHtml(markdown: string) {
  const escapeHtml = (value: string) => value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");

  const escaped = escapeHtml(markdown);

  const codeBlocks: string[] = [];
  const withCodeBlocks = escaped.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push(`<pre><code>${code.trim()}</code></pre>`);
    return placeholder;
  });

  const paragraphs = withCodeBlocks
    .split(/\n\n+/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      if (/^#{1,6} / .test(block)) {
        const level = block.match(/^#+/)?.[0].length || 1;
        const text = block.replace(/^#+\s*/, "");
        return `<h${level}>${text}</h${level}>`;
      }
      if (/^[-*] /m.test(block)) {
        const items = block.split(/\n/).filter((line) => /^[-*] / .test(line)).map((line) => `<li>${line.replace(/^[-*]\s*/, "")}</li>`).join("");
        return `<ul>${items}</ul>`;
      }
      if (/^\d+\. /m.test(block)) {
        const items = block.split(/\n/).filter((line) => /^\d+\. / .test(line)).map((line) => `<li>${line.replace(/^\d+\.\s*/, "")}</li>`).join("");
        return `<ol>${items}</ol>`;
      }
      return `<p>${trimmed
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\[(.+?)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
        .replace(/https?:\/\/\S+/g, '<a href="$&" target="_blank" rel="noreferrer">$&</a>')
      }</p>`;
    })
    .join("");

  return paragraphs.replace(/__CODE_BLOCK_(\d+)__/g, (_match, index) => codeBlocks[Number(index)] || "");
}

function GeneralChat() {
  const skills = [
    { key: "core-operations-engineer", label: "Core Operations Engineer", description: "Automation, reliability, infrastructure health, and operational excellence." },
    { key: "incident-management", label: "Incident Management", description: "Triage, escalation, communications, RCA, and service restoration." },
    { key: "cloud-architect", label: "Cloud Architect", description: "Cloud design, cost optimization, resiliency, and platform decisions." },
    { key: "devops-engineer", label: "DevOps Engineer", description: "CI/CD, pipelines, deployments, automation, and environment reliability." },
    { key: "security-analyst", label: "Security Analyst", description: "Threat review, hardening, IAM, and security best practices." },
    { key: "documentation", label: "Documentation", description: "Runbooks, issue notes, SOPs, and technical writing support." },
  ] as const;

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chatBodyRef = useRef<HTMLDivElement | null>(null);

  const detectSkillByText = (text: string) => {
    const lowered = text.toLowerCase();
    if (/(incident|outage|pager|sev|on-call|alert|rollback|rto|rpo|root cause|incident response)/.test(lowered)) return skills[1];
    if (/(aws|azure|gcp|terraform|architecture|cloud|network|cost optimization|resilience|scalability|multi-region|platform design)/.test(lowered)) return skills[2];
    if (/(ci\/cd|deployment|pipeline|release automation|gitlab|github actions|jenkins|devops|docker|kubernetes|helm|infrastructure as code)/.test(lowered)) return skills[3];
    if (/(security|iam|vault|vulnerability|threat|hardening|zero trust|cert|encryption|penetration|sso|auth)/.test(lowered)) return skills[4];
    if (/(runbook|procedure|sop|release note|documentation|document|how-to|guide|wiki|readme|manual|knowledge base|writeup|technical doc)/.test(lowered)) return skills[5];
    if (/(infra|server|monitor|automation|pipeline|reliability|ops|availability|service health)/.test(lowered)) return skills[0];
    return skills[0];
  };

  const [activeSkill, setActiveSkill] = useState<(typeof skills)[number]>(skills[0]);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<{ role: string; text: string; attachments?: string[] }[]>([]);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (chatBodyRef.current) {
      chatBodyRef.current.scrollTop = chatBodyRef.current.scrollHeight;
    }
  }, [messages, loading]);

  function addAttachments(files: FileList | null) {
    if (!files) return;
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = () => {
        const imageData = typeof reader.result === "string" ? reader.result : "";
        if (imageData) setAttachments((current) => [...current, imageData]);
      };
      reader.readAsDataURL(file);
    });
  }

  function handlePaste(event: React.ClipboardEvent<HTMLFormElement>) {
    const imageItems = Array.from(event.clipboardData?.items || []).filter((item) => item.type.startsWith("image/"));
    if (!imageItems.length) return;
    event.preventDefault();
    const pastedFiles = imageItems.map((item) => item.getAsFile()).filter(Boolean) as File[];
    addAttachments(pastedFiles as unknown as FileList);
  }

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    if (!question.trim() && !attachments.length) return;

    const currentQuestion = question.trim();
    const selectedSkill = detectSkillByText(currentQuestion || "general assistance");
    setActiveSkill(selectedSkill);
    const currentAttachments = attachments.slice();

    // Session info is needed to persist memory locally
    const sessionInfo = getCurrentAccount();

    // Detect memory-like statements in the question and persist them silently in the background.
    const extracted = detectMemoryFromText(currentQuestion);
    if (sessionInfo?.username && Object.keys(extracted).length) {
      if (extracted.name) saveLocalBrain(sessionInfo.username, { name: extracted.name });
      if (extracted.role) saveLocalBrain(sessionInfo.username, { role: extracted.role });
      if (extracted.company) saveLocalBrain(sessionInfo.username, { company: extracted.company });
      if (extracted.topics && Array.isArray(extracted.topics)) {
        extracted.topics.forEach((topic: string) => addTopicToBrain(sessionInfo.username, topic));
      }
      if (extracted.notes) {
        saveLocalBrain(sessionInfo.username, { notes: Array.isArray(extracted.notes) ? extracted.notes : [extracted.notes] });
      }
      if (extracted.preferences) {
        const existing = readBrainFromLocalStorage(sessionInfo.username);
        saveLocalBrain(sessionInfo.username, { preferences: { ...(existing.preferences || {}), ...extracted.preferences } });
      }
      loadLocalBrain(sessionInfo.username).then((b) => setBrainState(b));
    }

    // Build an optimistic user message and update UI immediately
    const userMsg = { role: "user", text: currentQuestion || "Attached image", attachments: currentAttachments };
    const optimistic = [...messages, userMsg];

    setQuestion("");
    setAttachments([]);
    setMessages(optimistic);
    setLoading(true);

    try {
      // Ensure we have an active thread. If none, create one synchronously.
      let threadId = activeThreadId;
      if (!threadId && sessionInfo?.username) {
        const created = await fetch('/api/general/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: sessionInfo.username, title: 'New chat' }) });
        if (created.ok) {
          const cd = await created.json();
          threadId = cd.id;
          setActiveThreadId(threadId);
          setThreads((current) => [{ id: cd.id, title: cd.title, createdAt: cd.createdAt, messagesCount: 0 }, ...current]);
          // Persist the optimistic user message immediately to avoid loss when navigating away
          await saveThreadConvo(threadId, optimistic);
        } else {
          // fallback: save draft locally so it's not lost
          if (sessionInfo?.username) localStorage.setItem(`general-thread-draft-${sessionInfo.username}`, JSON.stringify(optimistic));
        }
      } else if (threadId) {
        // Persist the user message immediately
        await saveThreadConvo(threadId, optimistic);
      } else {
        // no session: keep a local draft
        const anonKey = `general-thread-draft-anon`;
        localStorage.setItem(anonKey, JSON.stringify(optimistic));
      }

      // Send general chats to the dedicated general memory endpoint so the server can persist user memory and generate an assistant reply
      const response = await fetch("/api/general/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: sessionInfo?.username || "",
          threadId,
          topic: selectedSkill.label,
          skill: selectedSkill.key,
          question: currentQuestion || "Analyze the attached image.",
          attachments: currentAttachments,
        }),
      });
      const text = await response.text();

      const assistantMsg = { role: "assistant", text };
      const next = [...optimistic, assistantMsg];
      setMessages(next);
      // persist assistant reply as well
      await saveThreadConvo(threadId, next);
    } catch {
      setMessages((items) => [...items, { role: "assistant", text: "I couldn't reach the chat service. Check Ollama in Settings and try again." }]);
    } finally {
      setLoading(false);
    }
  }

  const promptSuggestions = [
    "Core Operations Engineer",
    "Incident Management",
    "Cloud Architect",
    "DevOps Engineer",
    "Security Analyst",
    "Documentation",
  ];

  // Conversation threads (multi-thread sidebar)
  const [threads, setThreads] = useState<{ id: string; title: string; createdAt: string | null; messagesCount: number; lastUpdated?: string | null }[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [loadingThreads, setLoadingThreads] = useState(true);

  // Simple local 'brain' for quick facts (persisted to localStorage).
  // Schema (flexible): { name?: string, role?: string, company?: string, topics?: string[], preferences?: Record<string,string>, notes?: string[] }
  // synchronous read helper from localStorage (fast fallback)
  function readBrainFromLocalStorage(username?: string) {
    if (!username) return {} as Record<string, any>;
    try { return JSON.parse(localStorage.getItem(`general-brain-${username}`) || "{}"); } catch { return {}; }
  }

  async function loadLocalBrain(username?: string) {
    if (!username) return {} as Record<string, any>;
    // Prefer server-stored brain when available
    try {
      const res = await fetch(`/api/general/brain?username=${encodeURIComponent(username)}`);
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.data === 'object') {
          // also mirror into localStorage for offline use
          localStorage.setItem(`general-brain-${username}`, JSON.stringify(data.data));
          return data.data as Record<string, any>;
        }
      }
    } catch (err) {
      // ignore and fallback to localStorage
    }
    return readBrainFromLocalStorage(username);
  }
  async function saveLocalBrain(username: string, patch: Record<string, any>) {
    try {
      const existing = readBrainFromLocalStorage(username);
      // merge arrays/objects carefully
      const merged: Record<string, any> = { ...existing };
      Object.entries(patch).forEach(([k, v]) => {
        if (Array.isArray(v)) {
          merged[k] = Array.isArray(merged[k]) ? Array.from(new Set([...merged[k], ...v])) : Array.from(new Set(v));
        } else if (typeof v === 'object' && v !== null) {
          merged[k] = { ...(merged[k] || {}), ...(v as Record<string, any>) };
        } else {
          merged[k] = v;
        }
      });
      // persist locally
      localStorage.setItem(`general-brain-${username}`, JSON.stringify(merged));
      // attempt server persist (best-effort)
      try {
        await fetch('/api/general/brain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, data: merged }) });
      } catch { /* ignore server errors */ }
      return merged;
    } catch { /* ignore */ return {} as Record<string, any>; }
  }

  function addTopicToBrain(username: string, topic: string) {
    if (!username || !topic) return;
    try {
      const brain = readBrainFromLocalStorage(username);
      const topics = Array.isArray(brain.topics) ? brain.topics : [];
      const normalized = topic.trim();
      if (!normalized) return;
      if (!topics.some((t: string) => t.toLowerCase() === normalized.toLowerCase())) {
        topics.unshift(normalized);
      }
      const merged = saveLocalBrain(username, { topics });
      return merged;
    } catch { return; }
  }

  // Detect memory-like statements in user text and return structured facts
  function detectMemoryFromText(text: string) {
    const out: Record<string, any> = {};
    if (!text || !text.trim()) return out;
    const t = text.trim();
    // name patterns
    const nameRegex = /(?:my name is|call me|you can call me|i am (?:called)?|i'm called|i'm|i am)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/i;
    const nameMatch = t.match(nameRegex);
    if (nameMatch) out.name = nameMatch[1].trim();

    // role / title patterns (try to capture professions or roles)
    const roleRegex = /(?:i am a|i'm a|i am an|i'm an|i work as a|i work as an)\s+([a-zA-Z0-9\s\-]{2,60})/i;
    const roleMatch = t.match(roleRegex);
    if (roleMatch) out.role = roleMatch[1].trim();

    // company / organization
    const orgRegex = /(?:i work at|i work for|i'm at|i am at|i work in the|i work in)\s+([A-Z][\w\s&.\-]{1,60})/i;
    const orgMatch = t.match(orgRegex);
    if (orgMatch) out.company = orgMatch[1].trim();

    // studying / learning topics
    const studyRegex = /(?:i(?:'m| am) studying|i study|i(?:'m| am) learning|i'm learning about)\s+([\w\s\-,:]{2,120})/i;
    const studyMatch = t.match(studyRegex);
    if (studyMatch) out.topics = [studyMatch[1].trim()];

    // remember / note / from now on
    const rememberRegex = /(?:remember that|please remember that|note that|from now on,?)\s+(.{2,140})/i;
    const rememberMatch = t.match(rememberRegex);
    if (rememberMatch) out.notes = [rememberMatch[1].trim()];

    // preferences
    const prefRegex = /(?:i prefer|my preference is|i like|i don't like|i do not like)\s+(.{2,120})/i;
    const prefMatch = t.match(prefRegex);
    if (prefMatch) out.preferences = { text: prefMatch[1].trim() };

    return out;
  }

  useEffect(() => {
    const sessionInfo = getCurrentAccount();
    if (!sessionInfo || !sessionInfo.username) { setLoadingThreads(false); return; }
    (async () => {
      try {
        const res = await fetch(`/api/general/threads?username=${encodeURIComponent(sessionInfo.username)}`);
        if (!res.ok) { setLoadingThreads(false); return; }
        const data = await res.json();
        const list = Array.isArray(data.threads) ? data.threads : [];
        setThreads(list);
        if (list.length) {
          // Try to restore previously active thread if present
          const storedActive = localStorage.getItem(`general-active-thread-${sessionInfo.username}`);
          const first = storedActive && list.find((t: any) => t.id === storedActive) ? list.find((t: any) => t.id === storedActive) : list[0];
          setActiveThreadId(first.id);
          const threadRes = await fetch(`/api/general/threads/${encodeURIComponent(first.id)}?username=${encodeURIComponent(sessionInfo.username)}`);
          if (threadRes.ok) {
            const tdata = await threadRes.json();
            const msgs = Array.isArray(tdata.convo) ? tdata.convo.map((m: any) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text, attachments: m.attachments || [] })) : [];
              // If we have a remembered name in the local brain and it's not already present in the thread, prepend a short note
              setMessages(msgs as any[]);
            } else {
              setMessages([]);
            }
          } else {
          // create an initial thread automatically
          const create = await fetch('/api/general/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: sessionInfo.username, title: 'New chat' }) });
          if (create.ok) {
            const cd = await create.json();
            setThreads([{ id: cd.id, title: cd.title, createdAt: cd.createdAt, messagesCount: 0 }]);
            setActiveThreadId(cd.id);
            setMessages([]);
          }
        }
      } catch (e) {
        // ignore errors silently
      } finally {
        setLoadingThreads(false);
      }
    })();
  }, []);

  // persist active thread selection for quick restore across pages
  useEffect(() => {
    const sessionInfo = getCurrentAccount();
    if (!sessionInfo?.username) return;
    if (activeThreadId) {
      localStorage.setItem(`general-active-thread-${sessionInfo.username}`, activeThreadId);
    } else {
      localStorage.removeItem(`general-active-thread-${sessionInfo.username}`);
    }
  }, [activeThreadId]);

  // in-memory view of the local brain to render in the UI
  const [brainState, setBrainState] = useState<Record<string, any>>({});
  useEffect(() => {
    const sessionInfo = getCurrentAccount();
    if (!sessionInfo?.username) return;
    // async load and set brain snapshot
    loadLocalBrain(sessionInfo.username).then((b) => setBrainState(b));
  }, [threads, activeThreadId]);

  async function createNewThread() {
    const sessionInfo = getCurrentAccount();
    if (!sessionInfo?.username) return;
    try {
      const res = await fetch('/api/general/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: sessionInfo.username, title: 'New chat' }) });
      if (!res.ok) return;
      const data = await res.json();
      const newThread = { id: data.id, title: data.title, createdAt: data.createdAt, messagesCount: 0 };
      setThreads((current) => [newThread, ...current.filter((t) => t.id !== newThread.id)]);
      setActiveThreadId(newThread.id);
      setMessages([]);
    } catch (err) {
      // ignore
    }
  }

  async function switchThread(threadId: string) {
    const sessionInfo = getCurrentAccount();
    if (!sessionInfo?.username) return;
    try {
      const res = await fetch(`/api/general/threads/${encodeURIComponent(threadId)}?username=${encodeURIComponent(sessionInfo.username)}`);
      if (!res.ok) return;
      const data = await res.json();
      const msgs = Array.isArray(data.convo) ? data.convo.map((m: any) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text, attachments: m.attachments || [] })) : [];
      setMessages(msgs as any[]);
      setActiveThreadId(threadId);
    } catch {
      // ignore
    }
  }

  async function saveThreadConvo(threadId: string | null, convo: any[]) {
    if (!threadId) return;
    const sessionInfo = getCurrentAccount();
    if (!sessionInfo?.username) return;
    try {
      await fetch(`/api/general/threads/${encodeURIComponent(threadId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: sessionInfo.username, convo }) });
      // optimistic update: mark thread as touched and move to top
      setThreads((current) => {
        const updated = current.filter((t) => t.id !== threadId);
        return [{ id: threadId, title: current.find((t) => t.id === threadId)?.title || 'Conversation', createdAt: current.find((t) => t.id === threadId)?.createdAt || new Date().toISOString(), messagesCount: convo.length }, ...updated];
      });
    } catch (err) {
      // ignore
    }
  }

  // Rename a thread (prompt for new title and save)
  async function renameThread(threadId: string) {
    const sessionInfo = getCurrentAccount();
    if (!sessionInfo?.username) return;
    const current = threads.find((t) => t.id === threadId);
    const newTitle = window.prompt('Rename conversation', current?.title || 'Conversation');
    if (!newTitle || !newTitle.trim()) return;
    try {
      // fetch existing convo to avoid overwriting
      const res = await fetch(`/api/general/threads/${encodeURIComponent(threadId)}?username=${encodeURIComponent(sessionInfo.username)}`);
      const data = res.ok ? await res.json() : { convo: [] };
      await fetch(`/api/general/threads/${encodeURIComponent(threadId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: sessionInfo.username, title: newTitle.trim(), convo: data.convo || [] }) });
      setThreads((current) => current.map((t) => t.id === threadId ? { ...t, title: newTitle.trim() } : t));
    } catch (err) {
      // ignore
    }
  }

  // Delete a thread after confirmation
  async function deleteThread(threadId: string) {
    const sessionInfo = getCurrentAccount();
    if (!sessionInfo?.username) return;
    if (!window.confirm('Delete this conversation? This cannot be undone.')) return;
    try {
      const res = await fetch(`/api/general/threads/${encodeURIComponent(threadId)}?username=${encodeURIComponent(sessionInfo.username)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete failed');
      setThreads((current) => current.filter((t) => t.id !== threadId));
      // if deleted active thread, switch to the first available or create new
      if (activeThreadId === threadId) {
        if (threads.length > 1) {
          const next = threads.find((t) => t.id !== threadId);
          if (next) await switchThread(next.id);
        } else {
          await createNewThread();
        }
      }
    } catch (err) {
      // ignore
    }
  }

  // Wire messages saving: whenever messages change, persist to active thread (debounced lightly)
  useEffect(() => {
    if (!activeThreadId) return;
    const timeout = setTimeout(() => { void saveThreadConvo(activeThreadId, messages); }, 800);
    return () => clearTimeout(timeout);
  }, [messages, activeThreadId]);

  function loadMemoryIntoChat() {
    // kept for backward compatibility; switch to the most recent thread if available
    if (threads && threads.length) switchThread(threads[0].id);
  }

  return (
    <div className="page general-ai-page">
      <div className="general-ai-shell">
        <div className="general-ai-header">
          <div className="eyebrow">GENERAL CHAT</div>
          <h1>Talk with a specialist assistant.</h1>
          <p>The assistant is ready by default: operations, incident response, technical writing, and documentation.</p>
        </div>

        <div className="general-ai-layout">
          <section className="panel general-ai-card">
            <div className="general-ai-card-header">
              <div className="general-ai-skill-pill">
                <div className="general-ai-skill-icon"><Brain size={16} /></div>
                <div className="general-ai-skill-copy">
                  <span className="chip-label">Active skill</span>
                  <strong>{activeSkill.label}</strong>
                </div>
              </div>
              <span className="status-pill"><span className="status-dot"></span> Assistant</span>
            </div>

            <div className="chat-body" ref={chatBodyRef}>
              {messages.length === 0 ? (
                <div className="chat-empty">
                  <div className="empty-orb"><Brain size={28} /></div>
                  <h2>What do you need help with?</h2>
                  <p>Your General AI automatically picks the right specialist style, and images can be pasted or attached instantly.</p>
                  <div className="prompt-chips">
                    {promptSuggestions.slice(0, 4).map((prompt) => (
                      <button key={prompt} type="button" onClick={() => setQuestion(prompt)}>{prompt}</button>
                    ))}
                  </div>
                  <div className="prompt-chips prompt-chips--secondary">
                    {promptSuggestions.slice(4).map((prompt) => (
                      <button key={prompt} type="button" onClick={() => setQuestion(prompt)}>{prompt}</button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="message-list">
                  {messages.map((message, index) => (
                    <div className={`message message--${message.role}`} key={`${message.role}-${index}`}>
                      <div className="message-avatar">{message.role === "user" ? "ME" : <Sparkles size={14} />}</div>
                      <div className="message-content">
                        <div className="message-attachments">
                          {(message.attachments || []).map((attachment, attachmentIndex) => (
                            <img key={`${message.role}-${index}-${attachmentIndex}`} src={attachment} alt="Attached preview" className="message-image" />
                          ))}
                        </div>
                        <div className="message-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(message.text) }} />
                      </div>
                    </div>
                  ))}
                  {loading && (
                    <div className="message message--assistant">
                      <div className="message-avatar"><Sparkles size={14} /></div>
                      <div className="message-content"><p className="typing"><i></i><i></i><i></i></p></div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="chat-composer-wrap" style={{ padding: '12px 20px', background: 'transparent' }}>
              <form className="chat-input" onSubmit={ask} onPaste={handlePaste} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div className="chat-input-wrap" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={`Ask for ${activeSkill.label.toLowerCase()} help...`} style={{ width: '100%', padding: '12px 14px', borderRadius: 12, border: '1px solid rgba(0,0,0,0.08)', boxSizing: 'border-box' }} />
                  <button type="button" className="icon-btn chat-attach-btn" onClick={() => fileInputRef.current?.click()} aria-label="Attach image" style={{ padding: 8 }}><Upload size={16} /></button>
                  <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => addAttachments(event.target.files)} />
                </div>
                <button type="submit" className="send-btn" disabled={loading || (!question.trim() && !attachments.length)} style={{ width: 44, height: 44, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <ArrowRight size={17} />
                </button>
              </form>
              {attachments.length > 0 && (
                <div className="chat-attachment-bar" style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                  {attachments.map((attachment, index) => (
                    <div key={`attachment-${index}`} className="chat-attachment" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <img src={attachment} alt="Attached preview" style={{ maxHeight: 48, borderRadius: 6 }} />
                      <button type="button" onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={12} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <aside className="general-ai-aside panel">
            <div className="eyebrow">CONVERSATION HISTORY</div>
            <h3>Conversation memory</h3>
            <p>Previously saved conversation snippets are stored as long-term memory. The most recent memory is loaded automatically when you open this chat. Use New chat to start a fresh session.</p>
            <div className="context-list">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <small>Last updated: {threads && threads[0] && threads[0].lastUpdated ? new Date(threads[0].lastUpdated).toLocaleString() : (threads && threads[0] && threads[0].createdAt ? new Date(threads[0].createdAt).toLocaleString() : '—')}</small>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="primary-btn" onClick={() => { if (threads[0]) switchThread(threads[0].id); }}>Restore conversation</button>
                  <button className="secondary-btn" onClick={createNewThread}>New chat</button>
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <strong>Recent threads</strong>
                {threads && threads.length ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                    <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, paddingRight: 6 }}>
                        {threads.map((t) => (
                          <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px', borderRadius: 6, background: t.id === activeThreadId ? 'rgba(0,0,0,0.03)' : 'transparent' }}>
                            <div style={{ cursor: 'pointer', flex: 1 }} onClick={() => switchThread(t.id)}>
                              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ fontWeight: t.id === activeThreadId ? 600 : 500 }}>{t.title}</span>
                                <small style={{ marginLeft: 8 }}>{t.messagesCount}</small>
                              </div>
                              <div style={{ fontSize: 11, color: '#666' }}>{t.lastUpdated ? new Date(t.lastUpdated).toLocaleString() : (t.createdAt ? new Date(t.createdAt).toLocaleString() : '')}</div>
                            </div>
                            <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
                              <button title="Rename" type="button" className="icon-btn" onClick={() => renameThread(t.id)}><ChevronDown size={14} /></button>
                              <button title="Delete" type="button" className="icon-btn" onClick={() => deleteThread(t.id)}><Trash2 size={14} /></button>
                            </div>
                          </div>
                        ))}
                      </div>
                  </div>
                ) : (
                  <div className="muted-text">No saved conversation memory yet.</div>
                )}

                <div style={{ marginTop: 12 }}>
                  <strong>Stored memory</strong>
                  <div style={{ marginTop: 8 }}>
                    {(() => {
                      const sessionInfo = getCurrentAccount();
                      const brain = sessionInfo?.username ? brainState : {};
                      const factCount = Object.keys(brain || {}).reduce((count, key) => {
                        const value = (brain as Record<string, any>)[key];
                        if (Array.isArray(value)) return count + value.length;
                        if (typeof value === 'object' && value && !Array.isArray(value)) return count + Object.keys(value).length;
                        return count + (value ? 1 : 0);
                      }, 0);

                      if (!brain || factCount === 0) return <div className="muted-text">No personal memory saved yet.</div>;

                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div className="muted-text">Private memory is enabled and used automatically when helpful.</div>
                          <div><strong>Saved facts:</strong> {factCount}</div>
                          <div style={{ marginTop: 6 }}>
                            <button className="secondary-btn" onClick={async () => { const sessionInfo = getCurrentAccount(); if (!sessionInfo?.username) return; try { await fetch(`/api/general/brain?username=${encodeURIComponent(sessionInfo.username)}`, { method: 'DELETE' }); } catch {} localStorage.removeItem(`general-brain-${sessionInfo.username}`); setBrainState({}); }}>Clear memory</button>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>

              </div>
            </div>

            <hr style={{ margin: '14px 0', border: 'none', borderTop: '1px solid rgba(82,64,115,0.06)' }} />

            <div className="eyebrow">SPECIALTIES</div>
            <h3>Operational and documentation support.</h3>
            <p>These skills are built into the General AI, and the assistant automatically selects the best fit for your message.</p>
            <div className="context-list">
              {skills.map((skill) => <span key={skill.key}><Check size={14} />{skill.label}</span>)}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function Tutor({ context }: { context?: { moduleId?: string; chapterId?: string; chapterTitle?: string } | null }) { const [question, setQuestion] = useState(""); const [messages, setMessages] = useState<{ role: string; text: string }[]>([]); const [loading, setLoading] = useState(false); async function ask(event: React.FormEvent) { event.preventDefault(); if (!question.trim()) return; const current = question; setQuestion(""); setMessages((items) => [...items, { role: "user", text: current }]); setLoading(true); try { const response = await fetch("/api/tutor/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic: context?.chapterTitle ? context.chapterTitle : (context?.moduleId ? "your current module" : "your current learning path"), chapter: context?.chapterTitle || "the active chapter", chapterId: context?.chapterId || undefined, moduleId: context?.moduleId || undefined, question: current }) }); const text = await response.text(); setMessages((items) => [...items, { role: "assistant", text }]); } catch { setMessages((items) => [...items, { role: "assistant", text: "I couldn't reach the tutor service. Check Ollama in Settings and try again." }]); } setLoading(false); } return <div className="page tutor-page"><PageHeader eyebrow="TUTOR" title="Think out loud." description="Ask for a clearer explanation, a real-world scenario, or a challenge that tests your understanding." /><div className="tutor-layout"><section className="panel chat-panel"><div className="chat-context"><div className="context-icon"><Bot size={20} /></div><div><strong>Open context</strong><span>{context?.chapterTitle ? `Chapter: ${context.chapterTitle}` : (context?.moduleId ? `Module: ${context.moduleId}` : 'Ready to help with your next question')}</span></div><span className="status-pill"><span className="status-dot"></span> Ollama</span></div><div className="chat-body">{messages.length === 0 ? <div className="chat-empty"><div className="empty-orb"><Bot size={27} /></div><h2>What are you working through?</h2><p>The tutor keeps your current topic, progress, and weak areas in mind.</p><div className="prompt-chips">{["Explain this like I’m a beginner", "Give me a real-world example", "Quiz me on the basics", "What should I review next?"].map((prompt) => <button key={prompt} onClick={() => setQuestion(prompt)}>{prompt}</button>)}</div></div> : <div className="message-list">{messages.map((message, index) => <div className={`message message--${message.role}`} key={`${message.role}-${index}`}><div className="message-avatar">{message.role === "user" ? "AL" : <Sparkles size={14} />}</div><div className="message-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(message.text) }} /></div>)}{loading && <div className="message message--assistant"><div className="message-avatar"><Sparkles size={14} /></div><p className="typing"><i></i><i></i><i></i></p></div>}</div>}</div><form className="chat-input" onSubmit={ask}><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask anything about your current topic..." /><button className="primary-btn" disabled={loading || !question.trim()}><ArrowRight size={17} /></button></form></section><aside className="tutor-aside"><div className="eyebrow">GOOD TO KNOW</div><h3>Your tutor is better with context.</h3><p>When you study from a module, the tutor can explain the exact chapter, reference your sources, and tailor the difficulty to you.</p><div className="context-list"><span><Check size={14} />Current chapter</span><span><Check size={14} />Past answers</span><span><Check size={14} />Weak areas</span></div></aside></div></div>; }

function Flashcards() {
  const [cards, setCards] = useState<any[]>([]);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const modulesRes = await fetch('/api/modules').then((r) => r.json());
        const first = modulesRes.modules && modulesRes.modules[0];
        if (!first) { if (mounted) setError("Create a module first to build your deck."); return; }
        let res = await fetch(`/api/modules/${first.id}/flashcards`);
        let data = res.ok ? await res.json() : { flashcards: [] };
        if (!data.flashcards?.length) {
          const generated = await fetch(`/api/modules/${first.id}/regenerate/flashcards`, { method: "POST" });
          if (generated.ok) {
            res = await fetch(`/api/modules/${first.id}/flashcards`);
            data = res.ok ? await res.json() : { flashcards: [] };
          }
        }
        if (mounted) {
          setCards(data.flashcards || []);
          if (!data.flashcards?.length) setError("No study cards could be built for this module yet.");
        }
      } catch { if (mounted) setError("Could not load your flashcards."); }
      finally { if (mounted) setLoading(false); }
    })();
    return () => { mounted = false; };
  }, []);
  const card = cards[index];
  async function review(rating: 'again' | 'hard' | 'good' | 'easy') {
    if (!card) return;
    setFlipped(false);
    try {
      const response = await fetch(`/api/flashcards/${card.id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating }) });
      if (!response.ok) throw new Error("Review could not be saved");
      setIndex((i) => Math.min(cards.length - 1, i + 1));
    } catch { setError("This review could not be saved. Please try again."); }
  }
  return <div className="page flashcards-page"><PageHeader eyebrow="FLASHCARDS" title="Recall is a superpower." description="Turn the important ideas from your generated course into active recall practice." action={<span className="soft-badge">{cards.length} cards</span>} /><div className="flashcard-layout"><section>{loading ? <div className="empty-inline"><div className="empty-icon"><Sparkles size={24} /></div><div><strong>Building your deck…</strong><p>Turning course concepts and terms into review cards.</p></div></div> : card ? <><div className="flashcard-top"><span>YOUR DECK</span><span>{index + 1} / {cards.length}</span></div><button type="button" className={`flashcard ${flipped ? "is-flipped" : ""}`} onClick={() => setFlipped((value) => !value)}><div className="card-face card-front"><div className="card-type">QUESTION</div><h2>{card.question}</h2><span className="flip-hint">Tap to reveal the answer</span></div><div className="card-face card-back"><div className="card-type">ANSWER</div><h2>Answer</h2><p>{card.answer}</p></div></button><div className="card-actions"><button className="outline-btn" onClick={() => review('again')}><X size={16} /> Again</button><button className="soft-btn" onClick={() => review('hard')}><Clock3 size={16} /> Hard</button><button className="primary-btn" onClick={() => review('good')}><Check size={16} /> Good</button><button className="primary-btn" onClick={() => review('easy')}><Check size={16} /> Easy</button></div>{error && <div className="info-note"><CircleHelp size={15} /> {error}</div>}</> : <div className="empty-inline"><div className="empty-icon"><Layers3 size={24} /></div><div><strong>No cards ready</strong><p>{error || "Create or generate a module to build a smart deck."}</p></div></div>}</section><aside className="panel review-panel"><div className="eyebrow">SPACED REPETITION</div><h3>Review at the right moment.</h3><p>Study Lab spaces cards based on your confidence, so you spend time where it pays off.</p><div className="review-stats"><span><strong>{cards.filter(c => !c.lastReviewedAt).length}</strong><small>New</small></span><span><strong>{cards.filter(c => c.lastReviewedAt && (!c.nextReviewAt || new Date(c.nextReviewAt) <= new Date())).length}</strong><small>Due</small></span><span><strong>{cards.filter(c => c.lastReviewedAt && c.nextReviewAt && new Date(c.nextReviewAt) > new Date()).length}</strong><small>Scheduled</small></span></div></aside></div></div>;
}

function Plans() {
  const [plan, setPlan] = useState<StudyPlan | null>(() => {
    try { return JSON.parse(localStorage.getItem("study-plan") || "null") as StudyPlan | null; } catch { return null; }
  });
  const [editing, setEditing] = useState(!plan);
  const [goal, setGoal] = useState(plan?.goal || "");
  const [deadline, setDeadline] = useState(plan?.deadline || "");
  const [minutesPerDay, setMinutesPerDay] = useState(plan?.minutesPerDay || 30);
  const [knowledge, setKnowledge] = useState(plan?.knowledge || "Some familiarity");

  function savePlan(event: React.FormEvent) {
    event.preventDefault();
    if (!goal.trim() || !deadline) return;
    const days = Array.from({ length: 30 }, (_, index) => ({
      day: index + 1,
      title: index === 0 ? "Set your baseline" : index === 29 ? "Reflect and review" : index % 5 === 0 ? "Practice and check your understanding" : `Build the next layer of ${goal.trim()}`,
      minutes: Number(minutesPerDay),
      completed: false,
    }));
    const nextPlan = { goal: goal.trim(), deadline, minutesPerDay: Number(minutesPerDay), knowledge, createdAt: new Date().toISOString(), days };
    setPlan(nextPlan);
    localStorage.setItem("study-plan", JSON.stringify(nextPlan));
    setEditing(false);
  }

  function toggleDay(day: number) {
    if (!plan) return;
    const nextPlan = { ...plan, days: plan.days.map((item) => item.day === day ? { ...item, completed: !item.completed } : item) };
    setPlan(nextPlan);
    localStorage.setItem("study-plan", JSON.stringify(nextPlan));
  }

  const completed = plan?.days.filter((day) => day.completed).length || 0;
  return <div className="page">
    <PageHeader eyebrow="STUDY PLANS" title="Give your goal a shape." description="Turn a deadline into a rhythm you can actually keep." action={plan && <button className="outline-btn" onClick={() => setEditing((value) => !value)}>{editing ? "Close editor" : "Edit plan"}</button>} />
    {editing || !plan ? <form className="plan-builder panel" onSubmit={savePlan}>
      <div className="plan-art"><Target size={28} /></div>
      <div className="plan-builder-copy"><div className="eyebrow">BUILD A PLAN</div><h2>What are you working toward?</h2><p>Set a real goal and a realistic rhythm. Your 30-day plan is saved in this workspace.</p></div>
      <div className="plan-form-grid"><label className="plan-field"><span>Goal</span><input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="e.g. Pass AZ-104" /></label><label className="plan-field"><span>Deadline</span><input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label><label className="plan-field"><span>Minutes per day</span><select value={minutesPerDay} onChange={(event) => setMinutesPerDay(Number(event.target.value))}><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={120}>2 hours</option></select></label><label className="plan-field"><span>Current knowledge</span><select value={knowledge} onChange={(event) => setKnowledge(event.target.value)}><option>Just getting started</option><option>Some familiarity</option><option>Comfortable with the basics</option></select></label></div>
      <button className="primary-btn" disabled={!goal.trim() || !deadline}><Target size={16} /> Build my 30-day plan <ArrowRight size={16} /></button>
    </form> : <><div className="active-plan panel"><div className="active-plan-head"><div><div className="eyebrow">ACTIVE PLAN</div><h2>{plan.goal}</h2><p>Target date {new Date(`${plan.deadline}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · {plan.minutesPerDay} minutes per day</p></div><div className="plan-completion"><strong>{Math.round((completed / plan.days.length) * 100)}%</strong><span>{completed} of {plan.days.length} days</span></div></div><div className="progress-track"><div style={{ width: `${(completed / plan.days.length) * 100}%` }}></div></div></div><section className="plan-calendar"><div className="section-title"><h3>Next up</h3><span>Check off sessions as you go</span></div><div className="plan-day-list">{plan.days.slice(completed, completed + 7).map((day) => <button key={day.day} className={`plan-day ${day.completed ? "completed" : ""}`} onClick={() => toggleDay(day.day)}><span className="plan-day-number">{String(day.day).padStart(2, "0")}</span><span className="plan-day-copy"><strong>Day {day.day}</strong><small>{day.title}</small></span><span className="plan-day-time">{day.minutes} min</span><span className="plan-day-check">{day.completed ? <Check size={14} /> : ""}</span></button>)}</div></section></>}
    {!plan && <div className="plan-steps"><div><span>01</span><strong>Set the target</strong><p>Certification, interview, or a personal goal.</p></div><div><span>02</span><strong>Choose your rhythm</strong><p>Make the plan fit your real week.</p></div><div><span>03</span><strong>Adjust as you grow</strong><p>Check off each session and keep moving.</p></div></div>}
  </div>;
}

function Settings({ theme, setTheme, currentUser }: { theme: "light" | "dark"; setTheme: (theme: "light" | "dark") => void; currentUser: AuthSession | null }) {
  const saved = (() => { try { return JSON.parse(localStorage.getItem("study-settings") || "{}"); } catch { return {}; } })();
  const [activeTab, setActiveTab] = useState<SettingsTab>("ai");
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [difficulty, setDifficulty] = useState(saved.difficulty || "Intermediate");
  const [learningStyle, setLearningStyle] = useState(saved.learningStyle || "Balanced");
  const [studyTime, setStudyTime] = useState(saved.studyTime || "30 min/day");
  const [fontSize, setFontSize] = useState(saved.fontSize || "Default");
  const [animations, setAnimations] = useState(saved.animations !== false);
  const [researchDepth, setResearchDepth] = useState(saved.researchDepth || localStorage.getItem("research-depth") || "basic");
  const [userName, setUserName] = useState("");
  const [userUsername, setUserUsername] = useState("");
  const [userPassword, setUserPassword] = useState("");
  const [userError, setUserError] = useState("");
  const [accounts, setAccounts] = useState<AccountRecord[]>(() => ensureAdminAccount());
  const isAdmin = currentUser?.username.toLowerCase() === ADMIN_USERNAME.toLowerCase();
  function saveSettings(patch: Record<string, unknown>) {
    const next = { ...saved, difficulty, learningStyle, studyTime, fontSize, animations, researchDepth, ...patch };
    localStorage.setItem("study-settings", JSON.stringify(next));
  }
  function updateSetting(key: string, value: unknown) {
    if (key === "difficulty") setDifficulty(String(value));
    if (key === "learningStyle") setLearningStyle(String(value));
    if (key === "studyTime") setStudyTime(String(value));
    if (key === "fontSize") setFontSize(String(value));
    saveSettings({ [key]: value });
  }
  function chooseResearchDepth(value: string) {
    setResearchDepth(value);
    localStorage.setItem("research-depth", value);
    saveSettings({ researchDepth: value });
  }
  function createUser(event: React.FormEvent) {
    event.preventDefault();
    if (!isAdmin) {
      setUserError("Only the admin account can create new users.");
      return;
    }
    const trimmedName = userName.trim();
    const trimmedUsername = userUsername.trim();
    const trimmedPassword = userPassword.trim();
    if (!trimmedName || !trimmedUsername || !trimmedPassword) {
      setUserError("Add a name, username, and password for the new account.");
      return;
    }
    const nextAccounts = ensureAdminAccount();
    const usernameExists = nextAccounts.some((account) => account.username.toLowerCase() === trimmedUsername.toLowerCase());
    if (usernameExists) {
      setUserError("That username already exists. Choose another one.");
      return;
    }
    const userAccount: AccountRecord = { username: trimmedUsername, name: trimmedName, password: trimmedPassword, createdAt: new Date().toISOString(), totpEnabled: false, totpSecret: undefined };
    const updatedAccounts = [...nextAccounts, userAccount];
    writeAccounts(updatedAccounts);
    setAccounts(updatedAccounts);
    setUserName("");
    setUserUsername("");
    setUserPassword("");
    setUserError("");
  }

  async function check() {
    setChecking(true);
    try {
      const data = await fetch("/api/ollama/status").then((response) => response.json());
      setStatus(data);
    } finally {
      setChecking(false);
    }
  }

  const tabs: { id: SettingsTab; label: string; icon: typeof Bot }[] = [
    { id: "ai", label: "Study tools", icon: Bot },
    { id: "learning", label: "Learning preferences", icon: GraduationCap },
    { id: "appearance", label: "Appearance", icon: Moon },
    { id: "system", label: "System", icon: Settings2 },
    { id: "users", label: "User management", icon: Users },
  ];

  return <div className="page settings-page">
    <PageHeader eyebrow="SETTINGS" title="Make it yours." description="Tune the learning environment around how you think best." />
    <div className="settings-layout">
      <div className="settings-nav panel" role="tablist" aria-label="Settings sections">
        {tabs.map(({ id, label, icon: Icon }) => <button
          key={id}
          type="button"
          role="tab"
          aria-selected={activeTab === id}
          className={`setting-tab ${activeTab === id ? "active" : ""}`}
          onClick={() => setActiveTab(id)}
        ><Icon size={17} /> {label}</button>)}
      </div>
      <div className="settings-content">
        {activeTab === "ai" && <>
          <SettingsSection title="Ollama connection" description="Study Lab connects to Ollama from the Node server, never from the browser.">
            <div className="connection-card"><div className="connection-status"><div className={`connection-icon ${status?.connected ? "connected" : ""}`}><Bot size={19} /></div><div><strong>{status?.connected ? "Connected" : "Connection not tested"}</strong><span>{status?.message || "Check your local Ollama service to get started."}</span></div></div><div className="connection-model"><span>Model</span><strong>{status?.model || "qwen3.5:4b"}</strong><small>{status?.models?.length ? `${status.models.length} model${status.models.length === 1 ? "" : "s"} available` : "Set OLLAMA_BASE_URL in .env"}</small></div><button className="outline-btn" onClick={check} disabled={checking}>{checking ? "Checking..." : "Test connection"}</button></div>
            <div className="ollama-target"><span>Server target</span><code>{status?.baseUrl || "http://localhost:11434"}</code><p>For a local setup, start Ollama with <strong>ollama serve</strong>. The app will use the model named by DEFAULT_MODEL.</p></div>
          </SettingsSection>
          <SettingsSection title="Research depth" description="Choose how broadly Study Lab searches before it builds a path."><div className="settings-segmented">{[["basic", "Quick · 3–5 sources"], ["advanced", "Thorough · 5–10 sources"], ["deep", "Deep · 10+ sources"]].map(([value, label]) => <button type="button" key={value} className={researchDepth === value ? "selected" : ""} onClick={() => chooseResearchDepth(value)}>{label}</button>)}</div><div className="info-note"><CircleHelp size={15} /> {researchDepth === "basic" ? "A focused pass for a fast start." : researchDepth === "advanced" ? "A broader pass for more context." : "The broadest pass with extra source checking."} Your choice is used for new modules.</div></SettingsSection>
        </>}
        {activeTab === "learning" && <SettingsSection title="Learning preferences" description="Set defaults for new learning paths and keep your study rhythm realistic.">
          <div className="preference-grid">
            <Option label="Default difficulty" value={difficulty} options={["Auto", "Beginner", "Intermediate", "Advanced", "Expert"]} onChange={(value) => updateSetting("difficulty", value)} />
            <Option label="Learning style" value={learningStyle} options={["Balanced", "Theory heavy", "Practical", "Exam focused", "Project based"]} onChange={(value) => updateSetting("learningStyle", value)} />
            <Option label="Daily study time" value={studyTime} options={["15 min/day", "30 min/day", "1 hour/day", "2 hours/day"]} onChange={(value) => updateSetting("studyTime", value)} />
          </div>
          <div className="info-note"><Check size={15} /> These defaults are ready to use the next time you create a study module.</div>
        </SettingsSection>}
        {activeTab === "appearance" && <SettingsSection title="Appearance" description="Choose a calmer visual mode for longer sessions.">
          <div className="theme-options"><button type="button" className={theme === "light" ? "selected" : ""} onClick={() => { setTheme("light"); localStorage.setItem("theme", "light"); }}><div className="theme-preview theme-preview--light"></div><span>Light</span></button><button type="button" className={theme === "dark" ? "selected" : ""} onClick={() => { setTheme("dark"); localStorage.setItem("theme", "dark"); }}><div className="theme-preview theme-preview--dark"></div><span>Dark</span></button></div>
          <div className="preference-grid appearance-options"><Option label="Font size" value={fontSize} options={["Default", "Large", "Extra large"]} onChange={(value) => updateSetting("fontSize", value)} /><label className="toggle-field"><span>Animations</span><button type="button" role="switch" aria-checked={animations} className={`toggle ${animations ? "is-on" : ""}`} onClick={() => { const next = !animations; setAnimations(next); saveSettings({ animations: next }); }}><span></span></button><small>{animations ? "Subtle motion is on" : "Reduced motion is on"}</small></label></div>
        </SettingsSection>}
        {activeTab === "system" && <SettingsSection title="System status" description="Check the services that power your learning experience.">
          <div className="system-status-list"><div className="system-status-row"><span><Bot size={17} /> Ollama</span><strong className={status?.connected ? "status-ok" : ""}>{status?.connected ? "Connected" : "Not tested"}</strong></div><div className="system-status-row"><span><Search size={17} /> Tavily research</span><strong>Server configured</strong></div><div className="system-status-row"><span><BookOpen size={17} /> Learning library</span><strong>{modulesStatusLabel()}</strong></div></div>
          <button type="button" className="outline-btn system-check" onClick={check} disabled={checking}>{checking ? "Checking services..." : "Check Ollama status"}</button>
          <div className="info-note"><CircleHelp size={15} /> Connection checks run securely through the Node server.</div>
        </SettingsSection>}
        {activeTab === "users" && <SettingsSection title="User management" description={isAdmin ? "Create learner accounts and keep each profile isolated in its own learning library." : "Only the admin account can create and manage users."}>
          {isAdmin ? <>
            <form className="plan-builder panel" onSubmit={createUser}>
              <div className="plan-form-grid">
                <label className="plan-field"><span>Display name</span><input value={userName} onChange={(event) => setUserName(event.target.value)} placeholder="Jamie Lee" /></label>
                <label className="plan-field"><span>Username</span><input value={userUsername} onChange={(event) => setUserUsername(event.target.value)} placeholder="jamie" /></label>
                <label className="plan-field"><span>Password</span><input type="password" value={userPassword} onChange={(event) => setUserPassword(event.target.value)} placeholder="••••••••" /></label>
              </div>
              {userError && <div className="auth-error">{userError}</div>}
              <button type="submit" className="primary-btn">Create user account</button>
            </form>
            <div className="system-status-list">
              {accounts.map((account) => <div className="system-status-row" key={account.username}><span><Users size={17} /> {account.name}</span><strong>{account.username}</strong></div>)}
            </div>
            {currentUser && <>
              <div className="panel plan-builder" style={{ marginTop: 12 }}>
                <div className="plan-form-grid">
                  <div style={{ gridColumn: '1/-1' }}>
                    <strong>Two-step verification (Microsoft Authenticator)</strong>
                    <p className="muted-text">Add TOTP-based two-step verification for your account.</p>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                      {(() => {
                        const acct = accounts.find(a => a.username === currentUser.username);
                        return acct?.totpEnabled ? <><span className="status-dot" /> Enabled</> : <><span className="status-dot" /> Disabled</>;
                      })()}
                      <button className="primary-btn" onClick={async () => {
                        const secret = generateBase32Secret();
                        const issuer = encodeURIComponent('Study Lab');
                        const label = encodeURIComponent(currentUser.username);
                        const otpauth = `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
                        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(otpauth)}`;
                        // open the QR in a new tab so the user can scan it with Microsoft Authenticator
                        const w = window.open();
                        if (w) { w.document.write(`<div style="font-family: sans-serif; text-align:center; padding:16px;"><h3>Scan this QR in Microsoft Authenticator</h3><img src="${qrUrl}" alt="Scan QR" style="max-width:100%;height:auto;"/><p>Or use secret: <code>${secret}</code></p></div>`); }
                        const code = window.prompt("Enter the 6-digit code from Microsoft Authenticator to verify and enable 2FA:");
                        if (!code) return;
                        try {
                          const ok = await verifyTotp(secret, code.trim());
                          if (!ok) { window.alert("Invalid code. Setup cancelled."); return; }
                          const next = accounts.map(a => a.username === currentUser.username ? { ...a, totpEnabled: true, totpSecret: secret } : a);
                          writeAccounts(next);
                          setAccounts(next);
                          window.alert("Two-step verification enabled for your account.");
                        } catch {
                          window.alert("Verification failed. Try again.");
                        }
                      }}>Enable Microsoft Authenticator</button>
                      <button className="text-btn" onClick={() => {
                        const next = accounts.map(a => a.username === currentUser.username ? { ...a, totpEnabled: false, totpSecret: undefined } : a);
                        writeAccounts(next);
                        setAccounts(next);
                      }}>Disable</button>
                    </div>
                  </div>
                </div>
              </div>
            </>}
          </> : <div className="info-note"><CircleHelp size={15} /> You are not signed in as the admin account, so user creation is locked.</div>}
        </SettingsSection>}
      </div>
    </div>
  </div>;

  function modulesStatusLabel() {
    return "Ready";
  }
}
function SettingsSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <section className="settings-section"><div className="settings-section-head"><h3>{title}</h3><p>{description}</p></div>{children}</section>; }