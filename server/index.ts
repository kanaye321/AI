import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createServer as createViteServer } from "vite";
import { checkOllama, generateJson, streamTutor, generateText } from "./services/ollama.js";
import { searchTavily, tavilyStatus } from "./services/tavily.js";
import { closeStore, initializeStore, storageStatus, store, type JobStage, type Module, type Source, type Video, getExamByModule, getFlashcardsByModule, recordFlashcardReview } from "./store.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.get("/favicon.ico", (_req, res) => res.status(204).end());

const stages: JobStage[] = ["understanding", "researching", "analyzing", "curriculum", "pre-exam", "chapters", "videos", "flashcards", "final-exam"];
const stageLabels: Record<JobStage, string> = {
  understanding: "Understanding your goal", researching: "Researching topic", analyzing: "Analyzing sources", curriculum: "Creating curriculum", "pre-exam": "Creating pre-exam", chapters: "Creating chapters", videos: "Finding relevant videos", flashcards: "Creating flashcards", "final-exam": "Building final exam", completed: "Complete", error: "Needs attention",
};

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeText(value: unknown, fallback = "", maxLength = 4000) {
  return typeof value === "string" ? value.slice(0, maxLength) : fallback;
}
function validAssessmentQuestions(value: unknown, minimum: number) {
  return Array.isArray(value) && value.length >= minimum && value.every((question) =>
    question && typeof question.question === "string" && question.question.trim().length > 20
    && typeof question.correctAnswer !== "undefined"
    && typeof question.explanation === "string" && question.explanation.trim().length > 10
  );
}

function videoMatchesTopic(title: string, snippet: string, topic: string, chapterTitle?: string) {
  const haystack = `${title} ${snippet}`.toLowerCase();
  const exactTerms = `${topic} ${chapterTitle || ""}`.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 3);
  const uniqueTerms = [...new Set(exactTerms)];
  if (chapterTitle && haystack.includes(chapterTitle.toLowerCase())) return true;
  const matches = uniqueTerms.filter((term) => haystack.includes(term)).length;
  return matches >= Math.min(2, uniqueTerms.length);
}

function normalizeChapterContent(raw: Record<string, unknown> | null | undefined, topic: string, fallbackTitle: string, description: string) {
  const data = raw && typeof raw === "object" ? raw : {};
  const intro = safeText(data.intro || data.introduction || data.context, `In this chapter, you will learn the key ideas behind ${fallbackTitle} and why they matter in ${topic}.`);
  const concept = safeText(data.concept || data.mainConcept || data.explanation, `The core idea is that ${fallbackTitle} matters because it explains how ${topic} works in a practical, usable way.`);
  const workedExample = safeText(data.workedExample || data.example || data.caseStudy || (Array.isArray(data.realWorldExamples) ? data.realWorldExamples[0] : undefined), `A worked example shows how ${fallbackTitle} plays out in a realistic situation so the theory becomes usable.`);
  const exercise = safeText(data.exercise || data.practicalExercise || data.practice || data.assignment, `Practice by explaining ${fallbackTitle} in your own words, then apply it to a realistic task or decision.`);
  const recap = safeText(data.recap || data.summary || data.lessonWrapUp, `Recap: understand the idea, connect it to a concrete example, and then apply it intentionally before moving on.`);
  const detailedExplanation = safeText(
    data.detailedExplanation || data.lesson || `${intro}\n\n${concept}\n\n${workedExample}\n\n${exercise}\n\n${recap}`,
    `${intro} ${concept} ${workedExample} ${exercise} ${recap}`,
    12000,
  );
  const keyTakeaways = (Array.isArray(data.keyTakeaways) ? data.keyTakeaways : []).filter((value): value is string => typeof value === "string").slice(0, 6);
  const normalizedTakeaways = keyTakeaways.length ? keyTakeaways : [
    `Understand the central idea behind ${fallbackTitle}.`,
    `Connect ${fallbackTitle} to a real task or problem.`,
    `Explain the concept in your own words before moving on.`,
    `Use the worked example to test your understanding.`,
    `Create one practical application for the lesson.`,
  ];
  const coreConcepts = Array.isArray(data.coreConcepts) && data.coreConcepts.length ? data.coreConcepts.filter((item) => !!item && typeof item === "object").map((item) => ({ title: safeText((item as Record<string, unknown>).title, "Concept"), explanation: safeText((item as Record<string, unknown>).explanation, "This concept matters because it connects the theory to real usage.") })) : [
    { title: "Core idea", explanation: concept },
    { title: "Why it matters", explanation: `This lesson matters because ${fallbackTitle} helps you understand how ${topic} works in context.` },
    { title: "Worked example", explanation: workedExample },
    { title: "Practice check", explanation: exercise },
  ];
  const realWorldExamples = Array.isArray(data.realWorldExamples) ? data.realWorldExamples.filter((value): value is string => typeof value === "string") : [workedExample];
  const extra = {
    why: safeText(data.why, `This chapter matters because it helps you connect the idea behind ${fallbackTitle} to real work and better decisions.`),
    learningObjectives: Array.isArray(data.learningObjectives) ? data.learningObjectives.filter((value): value is string => typeof value === "string").slice(0, 5) : [
      `Explain the core idea behind ${fallbackTitle}.`,
      `Use the concept in a realistic scenario.`,
      `Recognize where it can go wrong or be misapplied.`
    ],
    prerequisites: Array.isArray(data.prerequisites) ? data.prerequisites.filter((value): value is string => typeof value === "string").slice(0, 5) : [
      `A basic understanding of ${topic}.`,
      `Willingness to apply the concept in realistic tasks.`
    ],
    intro,
    concept,
    workedExample,
    exercise,
    recap,
    detailedExplanation,
    coreConcepts,
    stepByStep: Array.isArray(data.stepByStep) ? data.stepByStep.filter((value): value is string => typeof value === "string").slice(0, 6) : [
      `Start by recognizing the problem or goal of ${fallbackTitle}.`,
      `Understand the underlying concept in plain language.`,
      `Study a worked example that shows the concept in action.`,
      `Apply the concept to a small realistic task.`,
      `Check for mistakes or gaps in your reasoning.`,
      `Summarize the lesson and repeat the key idea.`
    ],
    realWorldExamples,
    practicalExamples: Array.isArray(data.practicalExamples) ? data.practicalExamples.filter((value): value is string => typeof value === "string") : [workedExample],
    technicalExamples: Array.isArray(data.technicalExamples) ? data.technicalExamples.filter((value): value is string => typeof value === "string") : [workedExample],
    commonMistakes: Array.isArray(data.commonMistakes) ? data.commonMistakes.filter((value): value is string => typeof value === "string") : [
      `Confusing the concept with a surface-level definition.`,
      `Applying it without checking the actual context.`,
      `Skipping the worked example and going straight to memorization.`
    ],
    troubleshooting: Array.isArray(data.troubleshooting) ? data.troubleshooting.filter((value): value is string => typeof value === "string") : [
      `If the idea feels abstract, walk through a concrete example before retrying the concept.`,
      `If you cannot explain it in plain language, simplify the concept and reconnect it to the problem.`
    ],
    bestPractices: Array.isArray(data.bestPractices) ? data.bestPractices.filter((value): value is string => typeof value === "string") : [
      `Learn with purpose, not memorization.`,
      `Use a realistic example before abstract statements.`,
      `Review the recap and test yourself without notes.`
    ],
    importantTerms: Array.isArray(data.importantTerms) ? (data.importantTerms as unknown[]).filter((value) => !!value && typeof value === "object").map((value) => ({ term: safeText((value as Record<string, unknown>).term, "Key term"), definition: safeText((value as Record<string, unknown>).definition, "This term is central to the concept.") })) : [
      { term: fallbackTitle, definition: `The central idea behind the lesson: ${concept}` }
    ],
    keyTakeaways: normalizedTakeaways,
    visualExplanation: safeText(data.visualExplanation, `A simple diagram would show the core idea, the example, and how it connects back to the broader topic of ${topic}.`),
    practicalExercise: exercise,
    scenarioExercise: safeText(data.scenarioExercise, `Imagine a realistic scenario involving ${fallbackTitle}. Explain what matters most and how you would apply the lesson.`),
    // Keep enough chapter-specific checks for the quality gate. Truncating
    // generated quizzes to four made the required five-question threshold
    // impossible to satisfy and forced every otherwise-strong chapter into
    // the slow expansion retry.
    quickQuiz: Array.isArray(data.quickQuiz) ? data.quickQuiz.slice(0, 12) : [
      { id: `${fallbackTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-q1`, type: "multiple_choice", question: `What is the main purpose of learning ${fallbackTitle}?`, options: ["Memorize a phrase", "Apply the concept to a real task", "Skip the worked example"], correctAnswer: "Apply the concept to a real task", explanation: "The goal is to use the idea in context, not just repeat it." },
      { id: `${fallbackTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-q2`, type: "true_false", question: `A good understanding of ${fallbackTitle} should let you explain it in plain language.`, options: ["True", "False"], correctAnswer: "True", explanation: "Plain-language explanation is a strong sign of genuine understanding." }
    ],
    furtherReading: Array.isArray(data.furtherReading) ? data.furtherReading.filter((value) => !!value && typeof value === "object").map((value) => ({ title: safeText((value as Record<string, unknown>).title, `Further reading on ${fallbackTitle}`), url: safeText((value as Record<string, unknown>).url, "https://example.com") })) : [{ title: `Learn more about ${fallbackTitle}`, url: "https://example.com" }],
    sources: Array.isArray(data.sources) ? data.sources.filter((value) => !!value && typeof value === "object") as any[] : []
  };
  if (extra.detailedExplanation.trim().length < 1800) {
    extra.detailedExplanation = [
      extra.detailedExplanation,
      ...extra.coreConcepts.map((item) => `${item.title}\n${item.explanation}`),
      ...extra.stepByStep,
      ...extra.realWorldExamples,
      ...extra.practicalExamples,
      ...extra.technicalExamples,
      ...extra.bestPractices,
    ].filter(Boolean).join("\n\n");
  }
  return { ...data, ...extra, description };
}

function enrichChapterSummary(chapter: Record<string, unknown>, topic: string, fallbackTitle: string, index: number) {
  const content = typeof chapter.content === "object" ? (chapter.content as Record<string, unknown>) : undefined;
  const normalizedContent = normalizeChapterContent(content || chapter, topic, fallbackTitle, safeText(chapter.description, "A focused lesson in this learning path."));
  const introText = safeText(normalizedContent.intro, `This chapter introduces ${fallbackTitle} and why it matters in a real learning sequence.`);
  const conceptText = safeText(normalizedContent.concept, `The core idea is to understand ${fallbackTitle} and how it connects to the topic as a whole.`);
  const workedExampleText = safeText(normalizedContent.workedExample, `A practical example will show how ${fallbackTitle} works in context.`);
  const exerciseText = safeText(normalizedContent.exercise, `Practice by explaining ${fallbackTitle} in your own words and applying it to one realistic task.`);
  const recapText = safeText(normalizedContent.recap, `In recap, the lesson is about connecting the idea, the example, and the application.`);
  const detailedExplanation = safeText(
    normalizedContent.detailedExplanation || chapter.lesson || `${introText}\n\n${conceptText}\n\n${workedExampleText}\n\n${exerciseText}\n\n${recapText}`,
    `${fallbackTitle} helps you learn the most important ideas behind ${topic}. Start by understanding the core concept, then connect it to a real example and test yourself with a small exercise.`,
  );
  const keyTakeaways = Array.isArray(chapter.keyTakeaways)
    ? chapter.keyTakeaways.filter((value): value is string => typeof value === "string").slice(0, 6)
    : Array.isArray(normalizedContent.keyTakeaways)
      ? normalizedContent.keyTakeaways.filter((value: unknown): value is string => typeof value === "string").slice(0, 6)
      : [
          `Understand the main idea behind ${fallbackTitle}.`,
          `Connect ${fallbackTitle} to a practical task or real-world scenario.`,
          `Explain the concept in your own words before moving on.`,
        ];
  const example = safeText(chapter.example || (Array.isArray(normalizedContent.realWorldExamples) ? normalizedContent.realWorldExamples[0] : undefined) || normalizedContent.workedExample, `Apply ${fallbackTitle} to a real task or problem in your own work or study.`);
  const practicePrompt = safeText(chapter.practicePrompt || normalizedContent.practicalExercise || normalizedContent.exercise || normalizedContent.recap, `Without looking back, explain ${fallbackTitle} in your own words and give one example of when it matters.`);
  return {
    id: `${topic.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "module"}-chapter-${index + 1}`,
    title: safeText(chapter.title, `Chapter ${index + 1}`),
    description: safeText(chapter.description, "A focused lesson in this learning path."),
    minutes: Math.max(5, Number(chapter.minutes) || 25),
    completed: false,
    lesson: detailedExplanation,
    keyTakeaways,
    example,
    practicePrompt,
    content: normalizedContent,
  };
}
function validateModule(value: unknown, topic: string, options: Record<string, string>): Module {
  const input = value as Record<string, unknown>;
  const moduleId = randomUUID();
  const rawChapters = Array.isArray(input.chapters) ? input.chapters : [];
  const chapters = rawChapters.slice(0, 12).map((chapter, index) => {
    const item = chapter as Record<string, unknown>;
    const fallbackTitle = safeText(item.title, `Chapter ${index + 1}`);
    const enriched = enrichChapterSummary(item, topic, fallbackTitle, index);
    return { ...enriched, id: `${moduleId}-chapter-${index + 1}` };
  });
  if (!safeText(input.title) || chapters.length === 0) throw new Error("The generated module did not pass validation");
  const sources = Array.isArray(input.sources) ? input.sources.filter((source) => typeof source === "object").slice(0, 20).map((source) => {
    const item = source as Record<string, unknown>;
    return { title: safeText(item.title, "Verified source"), url: safeText(item.url), domain: safeText(item.domain), snippet: safeText(item.snippet), sourceType: safeText(item.sourceType, "Research source"), credibilityScore: Number(item.credibilityScore) || 3 };
  }) : [];
  return {
    id: moduleId, topic, title: safeText(input.title, topic), description: safeText(input.description, "A focused, adaptive learning path built around your goal."), difficulty: safeText(input.difficulty, options.difficulty || "Auto"), goal: options.goal || "General Learning", style: options.style || "Balanced", estimatedMinutes: Math.max(15, Number(input.estimatedMinutes) || chapters.length * 25), objectives: Array.isArray(input.objectives) ? input.objectives.filter((item): item is string => typeof item === "string").slice(0, 8) : ["Build a practical foundation", "Apply the core ideas", "Explain the topic with confidence"], chapters, sources, videos: [], createdAt: new Date().toISOString(), progress: 0,
  };
}

function fallbackModule(topic: string, options: Record<string, string>, sources: Source[]): Module {
  const isItil = topic.toLowerCase().includes("itil");
  const chapters = isItil
    ? [
        {
          title: "ITIL foundations and service value",
          description: "Understand what a service is, how service management creates value, and the difference between outputs and outcomes.",
          lesson: "ITIL 4 describes a service as a way of enabling value co-creation by helping customers achieve outcomes without having to manage specific costs and risks themselves. Service management is the set of organizational capabilities used to deliver that value. A useful way to think about value is as a shared result: the provider contributes products, access, and support while the consumer contributes needs, feedback, and participation. Outputs are the things produced, while outcomes are the results the customer is trying to achieve. Utility answers whether a service is fit for purpose; warranty answers whether it is fit for use, including availability, capacity, security, and continuity.",
          keyTakeaways: ["Services co-create value with consumers.", "Outputs are produced results; outcomes are achieved results.", "Utility is fit for purpose; warranty is fit for use.", "Service relationships include providers, consumers, and other stakeholders."],
          example: "An online learning platform's output is a working course portal. The outcome is that employees can complete required training reliably. Availability and secure access are part of the warranty.",
          practicePrompt: "For a service you use at work, identify its provider, consumer, output, desired outcome, utility, and one warranty requirement.",
          content: {
            intro: "This chapter introduces the service value idea: a service exists to create value for a customer, not just to produce an output.",
            concept: "The core concept is that value is created when a service helps a customer achieve an outcome while balancing costs and risks.",
            workedExample: "An online learning platform delivers a portal as an output, but the real value is that employees can complete required training reliably and with secure access.",
            exercise: "Name one service you use at work, describe its output, its desired outcome, and one warranty expectation.",
            recap: "Value is not just a feature list; it is the outcome the customer achieves while the provider manages cost, risk, and quality."
          }
        },
        {
          title: "The seven guiding principles",
          description: "Use the guiding principles to make better decisions when designing, changing, or improving services.",
          lesson: "The guiding principles are recommendations that apply in almost every circumstance: focus on value; start where you are; progress iteratively with feedback; collaborate and promote visibility; think and work holistically; keep it simple and practical; and optimize and automate. They are not a checklist to follow mechanically. Use them together, and look for trade-offs. For example, starting where you are prevents waste, while progressing iteratively helps you learn whether the existing approach is actually working.",
          keyTakeaways: ["Focus decisions on stakeholder value.", "Use existing capability before replacing it.", "Small steps and feedback reduce risk.", "Make work visible and consider the whole value stream.", "Simplify before automating."],
          example: "Before replacing a service desk tool, start where you are by measuring current wait times, then run a small improvement with visible feedback before committing to a full migration.",
          practicePrompt: "Choose one improvement you want to make. Which two guiding principles would reduce its risk, and how would you apply them?",
          content: {
            intro: "This chapter helps you make service decisions using principles that keep value, learning, and improvement at the center.",
            concept: "The guiding principles create a practical lens for how to make better service decisions without over-engineering the solution.",
            workedExample: "A team wants to upgrade its service desk tool. Instead of replacing it immediately, they start with current measurements, improve in steps, and use feedback to reduce risk.",
            exercise: "Choose a service improvement you want to make and explain which guiding principles would shape the decision.",
            recap: "Good service decisions are grounded in value, feedback, simplicity, and learning, not in rigid process for its own sake."
          }
        },
        {
          title: "The four dimensions of service management",
          description: "Evaluate services across people and organizations, information and technology, partners and suppliers, and value streams and processes.",
          lesson: "The four dimensions provide a balanced view of service management. Organizations and people covers roles, skills, culture, and structure. Information and technology covers data, knowledge, applications, infrastructure, and security. Partners and suppliers covers the external relationships needed to deliver the service. Value streams and processes covers how work flows from demand to value. A change that looks good in one dimension can fail if the other three are ignored.",
          keyTakeaways: ["People and culture shape how work is actually performed.", "Technology must support the service outcome, not exist for its own sake.", "Suppliers and contracts affect risk and service quality.", "Value streams reveal handoffs, delays, and unnecessary work."],
          example: "A monitoring upgrade may improve technology but still fail if the team lacks the skills to respond, the supplier contract excludes support, or alerts do not fit the incident value stream.",
          practicePrompt: "Map one service across all four dimensions. Which dimension is strongest, and which one creates the biggest current risk?",
        },
        {
          title: "The service value system and value chain",
          description: "See how guiding principles, governance, practices, and continual improvement work together to create value.",
          lesson: "The ITIL service value system explains how an organization turns opportunity and demand into value. Its components are guiding principles, governance, the service value chain, practices, and continual improvement. The six value chain activities are plan, improve, engage, design and transition, obtain and build, and deliver and support. They can be combined in different sequences depending on the situation. The goal is not to force every request through the same workflow; the goal is to create an effective flow of value.",
          keyTakeaways: ["The service value system connects demand to value.", "Governance directs and controls the organization.", "Value chain activities can be combined flexibly.", "Continual improvement is part of every service, not a one-time project."],
          example: "A new customer requirement may move from engage to design and transition, obtain and build, and deliver and support, while improve and plan continue throughout.",
          practicePrompt: "Take a service request and sketch the value chain activities it would pass through. Where could feedback or improvement enter the flow?",
        },
        {
          title: "Core practices and continual improvement",
          description: "Distinguish common ITIL practices and use a repeatable approach to improve services over time.",
          lesson: "Incident management restores normal service as quickly as possible and minimizes impact. Problem management investigates causes and reduces the likelihood or impact of incidents. Change enablement manages changes so useful changes can happen while risk remains controlled. The service desk provides a clear point of contact for users. Continual improvement asks what the vision is, where the organization is now, where it wants to be, how it will get there, and whether it achieved the target. These practices work together but have different purposes.",
          keyTakeaways: ["Incidents focus on restoring service.", "Problems focus on causes and preventing recurrence.", "Change enablement balances speed, value, and risk.", "Continual improvement uses measurable targets and feedback."],
          example: "A failed database causes an incident that the team restores quickly. A problem record then investigates why it failed, while change enablement approves the durable fix and continual improvement measures recurrence.",
          practicePrompt: "Describe an outage you know. Separate the incident response, the underlying problem, the required change, and the improvement measure.",
        },
      ].map((chapter) => ({ ...chapter, minutes: 30, completed: false, id: "" }))
    : [
        {
          title: `${topic} foundations`,
          description: `Build the essential vocabulary and mental model for ${topic}.`,
          lesson: `${topic} becomes easier to learn when you start with its core terms, purpose, and the problems it is designed to solve. Begin by writing down what you already believe about the topic, then compare each idea with a reliable definition. Focus on relationships between concepts rather than memorizing isolated facts.`,
          keyTakeaways: [`Define the central purpose of ${topic}.`, "Separate core concepts from supporting details.", "Use a mental model to organize new information."],
          example: `Write a short explanation of ${topic} for someone who has never encountered it before.`,
          practicePrompt: `What problem does ${topic} solve, and what evidence would show that it is working?`,
        },
        {
          title: `${topic} in practice`,
          description: `Apply the main ideas of ${topic} to a realistic situation.`,
          lesson: `The fastest way to turn knowledge of ${topic} into skill is to apply it to a concrete scenario. Start with the goal, identify the constraints, choose the relevant concepts, and explain why your approach fits. Compare your reasoning with an example and revise it.`,
          keyTakeaways: ["Start with the desired outcome.", "Connect decisions to constraints and evidence.", "Explain why an approach fits the situation."],
          example: `Create a small scenario involving ${topic} and write the steps you would take to handle it.`,
          practicePrompt: `What would you do first in a realistic ${topic} scenario, and what information would you need next?`,
        },
        {
          title: `${topic} review and next steps`,
          description: `Consolidate your understanding and identify what to practice next.`,
          lesson: `Review by retrieving the ideas without looking at your notes. Explain the topic aloud, draw a simple map of how the concepts connect, and identify one area where your explanation becomes uncertain. That uncertainty is the best target for another focused study session.`,
          keyTakeaways: ["Retrieval is stronger than rereading alone.", "Use diagrams and explanations to expose gaps.", "Turn uncertainty into a specific next study task."],
          example: `Create a one-page summary of ${topic} with definitions, relationships, and one worked example.`,
          practicePrompt: `Which part of ${topic} can you explain confidently, and which part needs another practice session?`,
        },
      ].map((chapter) => ({ ...chapter, minutes: 25, completed: false, id: "" }));

  const moduleId = randomUUID();
  return {
    id: moduleId,
    topic,
    title: isItil ? "ITIL v5 Service Management Core Concepts" : `${topic} study guide`,
    description: `A readable starter curriculum for ${topic}. AI-generated expansion will be available when Ollama is connected.`,
    difficulty: options.difficulty || "Intermediate",
    goal: options.goal || "General Learning",
    style: options.style || "Balanced",
    estimatedMinutes: chapters.length * 30,
    objectives: chapters.slice(0, 5).map((chapter) => chapter.title),
    chapters: chapters.map((chapter, index) => ({ ...chapter, id: `${moduleId}-chapter-${index + 1}` })),
    videos: [],
    sources,
    createdAt: new Date().toISOString(),
    progress: 0,
  };
}

async function collectChapterVideos(module: Module, topic: string, researchDepth: string): Promise<Video[]> {
  const chapterVideos: Video[] = [];
  for (const chapter of module.chapters) {
    try {
      const results = await searchTavily(`${topic} "${chapter.title}" site:youtube.com/watch`, researchDepth);
      const selected = results
        .filter((source) => (source.url.includes("youtube.com/") || source.url.includes("youtu.be/")) && videoMatchesTopic(source.title, source.snippet, topic, chapter.title))
        .sort((a, b) => Number(videoMatchesTopic(b.title, b.snippet, topic, chapter.title)) - Number(videoMatchesTopic(a.title, a.snippet, topic, chapter.title)))[0];
      if (selected) {
        chapterVideos.push({
          title: selected.title,
          url: selected.url,
          domain: selected.domain,
          chapterId: chapter.id,
        });
      }
    } catch (error) {
      console.warn(`Failed to gather chapter video for ${chapter.title}:`, error);
    }
  }

  // Do not invent or reuse generic URLs when research returns nothing.
  return chapterVideos;
}

async function collectResearchSources(topic: string, researchDepth: string): Promise<Source[]> {
  const queryCount = researchDepth === "deep" ? 4 : researchDepth === "advanced" ? 2 : 1;
  const querySuffixes = [
    "",
    " official documentation fundamentals concepts",
    " practical guide methods examples",
    " common mistakes troubleshooting best practices",
  ];
  const unique = new Map<string, Source>();

  for (let index = 0; index < queryCount; index += 1) {
    const query = `${topic}${querySuffixes[index] || " authoritative overview"}`;
    try {
      console.log(`[study][research] query ${index + 1}/${queryCount}: ${query}`);
      const results = await searchTavily(query, researchDepth);
      console.log(`[study][research] query ${index + 1}/${queryCount} returned ${results.length} result(s)`);
      for (const source of results) {
        if (!unique.has(source.url)) unique.set(source.url, source);
      }
    } catch (error) {
      console.warn(`Research query failed for "${query}":`, error);
    }
  }

  const sources = [...unique.values()];
  const minimum = researchDepth === "deep" ? 10 : researchDepth === "advanced" ? 5 : 3;
  if (sources.length < minimum && process.env.TAVILY_API_KEY) {
    throw new Error(`${researchDepth === "deep" ? "Deep" : "Thorough"} research returned only ${sources.length} unique sources; at least ${minimum} are required. Try again or check the research service.`);
  }
  return sources.slice(0, researchDepth === "deep" ? 20 : researchDepth === "advanced" ? 12 : 8);
}

async function runGeneration(jobId: string, topic: string, options: Record<string, string>) {
  let sources: Source[] = [];
  const startedAt = Date.now();
  const jobTag = jobId.slice(0, 8);
  const progress = (message: string) => console.log(`[study][${jobTag}] ${message} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  const advance = async (stage: JobStage) => {
    const job = store.getJob(jobId);
    progress(`stage → ${stageLabels[stage]}`);
    await store.updateJob(jobId, { stage, completedStages: [...(job?.completedStages || []), stage] });
    await delay(160);
  };
  try {
    await advance("understanding");

    // Research
    try {
      await advance("researching");
      sources = await collectResearchSources(topic, options.researchDepth);
      progress(`research complete: ${sources.length} unique source(s)`);
    } catch (err) {
      console.warn("Tavily research failed, continuing without web sources", err);
      if (process.env.TAVILY_API_KEY && options.researchDepth !== "basic") throw err;
      await advance("researching");
    }

    await advance("analyzing");
    progress("analyzing research and preparing course outline");
    const sourceContext = sources.length ? sources.map((source) => `${source.title} (${source.url}): ${source.snippet}`).join("\n") : "No web sources were available. Be explicit where information could not be verified.";

    // First: generate a curriculum map. Detailed content is generated chapter by
    // chapter below, but each chapter needs an explicit place in the learning arc.
    const outlineSystem = `You are a senior instructional designer and subject-matter expert. Design a complete, self-paced course, not a study-note outline. Return JSON only with title, description, difficulty, estimatedMinutes, objectives (5-8 measurable objectives), and chapters (5-12 items). Each chapter must be {title, description, minutes}. Choose the chapter count based on topic complexity. The sequence must be teachable from prerequisite foundations to practical competence: establish vocabulary and mental models first, then mechanisms and methods, then guided application, trade-offs and troubleshooting, and finally synthesis/mastery. Every chapter description must name the specific concepts and skill the learner will gain, not vague phrases such as "learn the basics". Avoid repeating the same subject in multiple chapters. The course description must state who it is for, what it teaches, what the learner will be able to do, the major areas covered, and an approximate duration. Objectives must use measurable verbs such as explain, distinguish, apply, analyze, design, or troubleshoot. Use authoritative research when available.`;
    const outlinePrompt = `Topic: ${topic}\nLearning goal: ${options.goal}\nDifficulty: ${options.difficulty}\nLearning style: ${options.style}\nStudy time: ${options.studyTime}\nResearch depth: ${options.researchDepth}\nCreate a coherent dependency-aware sequence. Later chapters must build on earlier chapters rather than restarting from definitions.\nVerified research:\n${sourceContext}`;

    await advance("curriculum");
    const outline = await generateJson<unknown>(outlineSystem, outlinePrompt);
    const moduleSkeleton = validateModule(outline, topic, options);
    progress(`outline complete: ${moduleSkeleton.chapters.length} chapter(s), ${moduleSkeleton.objectives.length} objective(s)`);
    // Attach the complete, deduplicated research set. Videos are collected per chapter below.
    moduleSkeleton.sources = sources.length ? sources : moduleSkeleton.sources.filter((s) => s.url);
    moduleSkeleton.videos = [];

    // Persist initial module so we have an ID and can progressively update chapters
    await store.addModule(moduleSkeleton);

    // Generate each chapter's detailed instructional content independently and persist
    await advance("chapters");
    const chapters = moduleSkeleton.chapters;
    for (const [idx, ch] of chapters.entries()) {
      progress(`chapter ${idx + 1}/${chapters.length} started: ${ch.title}`);
      const previousChapters = chapters.slice(0, idx).map((item, previousIndex) => `${previousIndex + 1}. ${item.title}: ${item.description}`).join("\n") || "None — this is the foundation chapter.";
      const followingChapters = chapters.slice(idx + 1).map((item, nextIndex) => `${idx + nextIndex + 2}. ${item.title}: ${item.description}`).join("\n") || "None — this is the final chapter.";
      const chapterSystem = `You are a professional instructor writing one complete, substantial chapter inside a sequential full course. Return JSON only. Teach the learner; do not return an outline, a short summary, generic study advice, or placeholders. Use these keys: why, learningObjectives (4-6 measurable strings), prerequisites (string[]), intro (string), concept (string), workedExample (string), exercise (string), recap (string), detailedExplanation (multi-paragraph string, normally 3000-6000 characters), coreConcepts (6-10 objects with title and explanation), stepByStep (at least 6 concrete steps or commands when relevant), realWorldExamples (at least 3), practicalExamples (at least 3), technicalExamples (at least 2 when relevant), commonMistakes (at least 4), troubleshooting (at least 3 when relevant), bestPractices (at least 4), importantTerms (at least 6 objects with term and definition), keyTakeaways (at least 6), visualExplanation, practicalExercise, scenarioExercise, quickQuiz (at least 6 questions), furtherReading (array of title and valid URL objects). For every major concept, include its definition, why it matters, relationships to other concepts, a concrete example, a real-world application, a misconception, and a practice opportunity across the fields above. Include explicit transitions from prior knowledge and explain what this chapter enables later. Make the exercise solvable from the chapter and include an expected approach or success criteria. Make quiz questions test recall, understanding, application, and scenario reasoning; provide correctAnswer and explanation. Do not pad the response with repeated definitions.`;
      const chapterPrompt = `Course: ${moduleSkeleton.title}\nTopic: ${topic}\nCourse objectives: ${moduleSkeleton.objectives.join("; ")}\nThis is chapter ${idx + 1} of ${chapters.length}.\nCurrent chapter: ${ch.title}\nCurrent chapter purpose: ${ch.description}\nPrevious chapters (what the learner already knows):\n${previousChapters}\nFollowing chapters (what this chapter must prepare for):\n${followingChapters}\nDifficulty progression: foundations first; this chapter must be at the appropriate stage and add new capability.\nVerified research:\n${sourceContext}`;

      let content: Record<string, any> | null = null;
      let attempt = 0;
      let success = false;
      while (attempt < 3 && !success) {
        attempt += 1;
        progress(`chapter ${idx + 1}/${chapters.length} attempt ${attempt}/3: requesting instructional content`);
        try {
          const generatedContent = await generateJson<unknown>(chapterSystem, chapterPrompt);
          const candidate = normalizeChapterContent(generatedContent as Record<string, unknown> | null, topic, ch.title, ch.description);
          if (!candidate || (typeof candidate.detailedExplanation !== "string" && !Array.isArray(candidate.coreConcepts) && !(Array.isArray(candidate.keyTakeaways) && candidate.keyTakeaways.length > 0))) {
            throw new Error("Chapter content validation failed — insufficient instructional material");
          }

              const isTechnical = /\b(c\+\+|python|java|aws|azure|linux|docker|kubernetes|microsoft|intune|networking|sql|postgres)\b/i.test(topic);
              const minDetailedChars = isTechnical ? 2600 : 2200;
              const coreConceptsCount = Array.isArray(candidate.coreConcepts) ? candidate.coreConcepts.length : 0;
              const quickQuizCount = Array.isArray(candidate.quickQuiz) ? candidate.quickQuiz.length : 0;
              const stepCount = Array.isArray(candidate.stepByStep) ? candidate.stepByStep.length : 0;
              const takeawayCount = Array.isArray(candidate.keyTakeaways) ? candidate.keyTakeaways.length : 0;
              const detailedLen = typeof candidate.detailedExplanation === 'string' ? candidate.detailedExplanation.trim().length : 0;

              if (detailedLen < minDetailedChars || coreConceptsCount < 6 || quickQuizCount < 5 || stepCount < 6 || takeawayCount < 5) {
                progress(`chapter ${idx + 1} depth check: ${detailedLen} chars, ${coreConceptsCount} concepts, ${quickQuizCount} quiz, ${stepCount} steps, ${takeawayCount} takeaways`);
                if (attempt < 3) {
                  console.warn(`Chapter content failed depth checks (len=${detailedLen}, concepts=${coreConceptsCount}, quiz=${quickQuizCount}, steps=${stepCount}, takeaways=${takeawayCount}), prompting expansion.`);
                    const expandSystem = `You are revising a course chapter that failed a depth check. Return JSON only and preserve accurate material while substantially adding teaching substance. This must be a self-contained lesson, not a summary: explain multiple concepts in sequence, define them, connect them, demonstrate them, give a solvable applied exercise and scenario, address misconceptions, and create knowledge-check questions with answers and explanations. Ensure detailedExplanation is at least ${minDetailedChars} characters, include at least 6 coreConcepts, 6 stepByStep items, 5 keyTakeaways, and 5 quickQuiz items.`;
                    try {
                      const expanded = await generateJson<any>(expandSystem, `Course: ${moduleSkeleton.title}\nObjectives: ${moduleSkeleton.objectives.join("; ")}\nChapter ${idx + 1}: ${ch.title}\nPurpose: ${ch.description}\nPrevious chapters: ${previousChapters}\nFollowing chapters: ${followingChapters}\nExisting partial chapter JSON to repair:\n${JSON.stringify(candidate).slice(0, 18000)}\nExpand this chapter into teachable content using the existing output as a base. Preserve accurate useful details, fill missing sections, and return the complete improved chapter JSON. Research:\n${sourceContext}`);
                    const merged = normalizeChapterContent({ ...candidate, ...(expanded || {}) }, topic, ch.title, ch.description);
                    const reLen = typeof merged.detailedExplanation === 'string' ? merged.detailedExplanation.trim().length : 0;
                    const reConcepts = Array.isArray(merged.coreConcepts) ? merged.coreConcepts.length : 0;
                    const reQuiz = Array.isArray(merged.quickQuiz) ? merged.quickQuiz.length : 0;
                    const reSteps = Array.isArray(merged.stepByStep) ? merged.stepByStep.length : 0;
                    const reTakeaways = Array.isArray(merged.keyTakeaways) ? merged.keyTakeaways.length : 0;
                    if (reLen >= minDetailedChars && reConcepts >= 6 && reQuiz >= 5 && reSteps >= 6 && reTakeaways >= 5) {
                      content = merged;
                      success = true;
                    } else {
                      progress(`chapter ${idx + 1} expansion still shallow: ${reLen} chars, ${reConcepts} concepts, ${reQuiz} quiz, ${reSteps} steps, ${reTakeaways} takeaways`);
                      throw new Error('Expanded content did not meet quality thresholds');
                    }
                  } catch (expandErr) {
                    console.warn(`Chapter expansion attempt failed for ${ch.title}:`, expandErr instanceof Error ? expandErr.message : expandErr);
                    if (attempt >= 3) throw new Error(`Chapter "${ch.title}" could not meet the study-material depth requirements after ${attempt} attempts.`);
                    await delay(400);
                  }
                } else {
                  throw new Error(`Chapter "${ch.title}" did not meet the study-material depth requirements.`);
                }
              } else {
                content = candidate;
                success = true;
              }
            } catch (err) {
              console.warn(`Chapter generation attempt ${attempt} failed for ${ch.title}:`, err instanceof Error ? err.message : err);
              if (attempt >= 3) {
                throw new Error(`Chapter "${ch.title}" generation failed after ${attempt} attempts: ${err instanceof Error ? err.message : "the model returned unusable content"}`);
              } else {
                await delay(400);
              }
            }
          }

      // update chapter with content and derive summary fields for UI (lesson/keyTakeaways/example/practicePrompt)
      if (!content) throw new Error(`Chapter content missing for ${ch.title}`);
      const updatedChapter = {
        ...ch,
        lesson: typeof content.detailedExplanation === "string" ? (content.detailedExplanation.slice(0, 4000)) : ch.lesson,
        keyTakeaways: Array.isArray(content.keyTakeaways) ? content.keyTakeaways.slice(0, 8) : ch.keyTakeaways,
        example: Array.isArray(content.realWorldExamples) && content.realWorldExamples.length ? content.realWorldExamples[0] : ch.example,
        practicePrompt: content.practicalExercise ?? ch.practicePrompt,
        content,
      };

      // persist update
      const currentModule = store.getModule(moduleSkeleton.id);
      if (!currentModule) throw new Error("Module disappeared during generation");
      const nextChapters = currentModule.chapters.map((c) => c.id === ch.id ? updatedChapter : c);
      await store.updateModule(currentModule.id, { chapters: nextChapters });
      progress(`chapter ${idx + 1}/${chapters.length} saved`);
    }

    // Never mark a shallow or partially generated module as complete. The old
    // behavior replaced failed chapters with generic advice, which looked like
    // a finished course but was not something a learner could study.
    const completedChapterData = store.getModule(moduleSkeleton.id)?.chapters || [];
    const weakChapter = completedChapterData.find((chapter) => {
      const content = chapter.content || {};
      return (content.detailedExplanation || "").trim().length < 1200
         || (content.coreConcepts || []).length < 6
         || (content.stepByStep || []).length < 6
         || (content.quickQuiz || []).length < 5;
    });
    if (weakChapter) {
      throw new Error(`Chapter "${weakChapter.title}" did not contain enough study material. Please retry generation with Ollama available.`);
    }

    // Videos
    await advance("videos");
    const moduleNow = store.getModule(moduleSkeleton.id);
    const savedVideos = (moduleNow?.videos || []).map((v) => ({ ...v }));
    const chapterVideos = await collectChapterVideos(moduleNow!, topic, options.researchDepth || "basic");
    progress(`video research complete: ${chapterVideos.length}/${moduleNow?.chapters.length || 0} chapter video(s) found`);
    const mergedVideos = [...savedVideos, ...chapterVideos].filter((video, index, array) => {
      const key = `${video.title}|${video.url}`;
      return array.findIndex((entry) => `${entry.title}|${entry.url}` === key) === index;
    });
    for (const video of mergedVideos) {
      let chapterId: string | undefined;
      for (const chapter of moduleNow?.chapters || []) {
        if (video.title.toLowerCase().includes(chapter.title.toLowerCase()) || video.url.includes(chapter.id)) {
          chapterId = chapter.id;
          break;
        }
      }
      (video as any).chapterId = chapterId ?? null;
    }
    await store.updateModule(moduleNow!.id, { videos: mergedVideos });

    // Derive flashcards from the generated concepts and terminology, rather than
    // creating generic "recall this takeaway" cards.
    await advance("flashcards");
    const flashcards: any[] = [];
    const moduleAfterChapters = store.getModule(moduleSkeleton.id)!;
    for (const ch of moduleAfterChapters.chapters) {
      const content = ch.content || {};
      const concepts = Array.isArray(content.coreConcepts) ? content.coreConcepts : [];
      const terms = Array.isArray(content.importantTerms) ? content.importantTerms : [];
      const takeaways = ch.keyTakeaways || content.keyTakeaways || [];
      concepts.slice(0, 12).forEach((concept: any, i) => {
        if (concept?.title && concept?.explanation) flashcards.push({ id: `${moduleSkeleton.id}-fc-${ch.id}-concept-${i}`, moduleId: moduleSkeleton.id, chapterId: ch.id, conceptId: `${ch.id}-concept-${i}`, question: `Explain ${concept.title} and why it matters in ${ch.title}.`, answer: concept.explanation, difficulty: i < 2 ? "medium" : "hard" });
      });
      terms.slice(0, 12).forEach((term: any, i) => {
        if (term?.term && term?.definition) flashcards.push({ id: `${moduleSkeleton.id}-fc-${ch.id}-term-${i}`, moduleId: moduleSkeleton.id, chapterId: ch.id, conceptId: `${ch.id}-term-${i}`, question: `What is ${term.term}?`, answer: term.definition, difficulty: "medium" });
      });
      if (!concepts.length && !terms.length) takeaways.slice(0, 5).forEach((takeaway, i) => flashcards.push({ id: `${moduleSkeleton.id}-fc-${ch.id}-takeaway-${i}`, moduleId: moduleSkeleton.id, chapterId: ch.id, conceptId: `${ch.id}-takeaway-${i}`, question: `Explain this idea from ${ch.title}: ${takeaway.split(".")[0]}`, answer: takeaway, difficulty: "medium" }));
    }
    if (flashcards.length) {
      try { await store.addFlashcards(flashcards); } catch (err) { console.warn("Failed to save flashcards:", err); }
    }

    // Pre-exam & final exam generation (lightweight): create exam records and questions
    await advance("pre-exam");
    try {
      const preExamSystem = `You are an expert diagnostic assessment author. Generate a PRE-EXAM with approximately 10 questions to measure prerequisite knowledge and current understanding before the course. Do not test material that has only just been taught. Mix multiple choice, true/false, short answer, and scenarios. Questions must reveal misconceptions and provide correctAnswer plus a brief explanation. Return JSON only: {id,title,description,questions:[{id,question,type,options,correctAnswer,explanation,conceptId,difficulty}]}.`;
      const preExamPrompt = `Module: ${moduleSkeleton.title}\nTopic: ${topic}\nObjectives: ${moduleSkeleton.objectives.join("; ")}\nPrerequisite diagnostic scope: vocabulary and foundational reasoning needed for these chapters.\nChapters in order:\n${moduleSkeleton.chapters.map((c, i) => `${i + 1}. ${c.title}: ${c.description}`).join("\n")}\nUse research only to keep terminology accurate:\n${sourceContext}`;
      const preExam = await generateJson<any>(preExamSystem, preExamPrompt);
      // save exam and questions
       if (preExam && validAssessmentQuestions(preExam.questions, 10)) {
        await store.addExam({ id: preExam.id || `${moduleSkeleton.id}-pre`, moduleId: moduleSkeleton.id, type: "pre", title: preExam.title || "Pre-Exam", description: preExam.description || "Diagnostic test", totalQuestions: preExam.questions.length }, preExam.questions.map((q: any, idx: number) => ({ id: q.id || `${moduleSkeleton.id}-pre-q-${idx}`, question: q.question, type: q.type, options: q.options || null, correctAnswer: q.correctAnswer || null, explanation: q.explanation || null, difficulty: q.difficulty || "medium", chapterId: q.chapterId ?? null, conceptId: q.conceptId ?? null, sortOrder: idx })));
       } else {
         throw new Error("Pre-exam generation did not return at least 10 answer-keyed questions with explanations.");
      }
    } catch (err) {
       console.error("Pre-exam generation failed:", err);
       throw err;
    }

    await advance("final-exam");
    try {
       const finalExamSystem = `You are an expert assessment author. Generate a comprehensive FINAL EXAM with 20 new questions based on the complete course below. Do not concatenate or copy chapter quizzes. Cover all major chapters and objectives with a deliberate mix of conceptual, application, troubleshooting, scenario, and difficult analysis questions. Include correctAnswer and an explanation for every question. Return JSON only: {id,title,description,questions:[{id,question,type,options,correctAnswer,explanation,conceptId,difficulty}]}.`;
       const finalExamPrompt = `Module: ${moduleSkeleton.title}\nTopic: ${topic}\nObjectives: ${moduleSkeleton.objectives.join("; ")}\nComplete course chapters and taught content:\n${moduleSkeleton.chapters.map((c, i) => {
         const content = c.content || {};
         const concepts = Array.isArray(content.coreConcepts) ? content.coreConcepts.map((item: any) => item.title).join(", ") : "";
         return `Chapter ${i + 1}: ${c.title}\nPurpose: ${c.description}\nConcepts taught: ${concepts}\nKey takeaways: ${(c.keyTakeaways || []).join("; ")}`;
       }).join("\n")}\nUse research only to keep terminology accurate:\n${sourceContext}`;
      const finalExam = await generateJson<any>(finalExamSystem, finalExamPrompt);
       if (finalExam && validAssessmentQuestions(finalExam.questions, 20)) {
        await store.addExam({ id: finalExam.id || `${moduleSkeleton.id}-final`, moduleId: moduleSkeleton.id, type: "final", title: finalExam.title || "Final Exam", description: finalExam.description || "Final test", totalQuestions: finalExam.questions.length }, finalExam.questions.map((q: any, idx: number) => ({ id: q.id || `${moduleSkeleton.id}-final-q-${idx}`, question: q.question, type: q.type, options: q.options || null, correctAnswer: q.correctAnswer || null, explanation: q.explanation || null, difficulty: q.difficulty || "hard", chapterId: q.chapterId ?? null, conceptId: q.conceptId ?? null, sortOrder: idx })));
       } else {
         throw new Error("Final exam generation did not return at least 20 answer-keyed questions with explanations.");
      }
    } catch (err) {
       console.error("Final exam generation failed:", err);
       throw err;
    }

    await store.updateJob(jobId, { stage: "completed", completedStages: [...stages, "completed"], moduleId: moduleSkeleton.id });
    progress(`completed successfully: module ${moduleSkeleton.id}`);
  } catch (error) {
    console.error(`[study] generation failed for "${topic}"`, error);
    progress(`failed: ${error instanceof Error ? error.message : "unknown generation error"}`);
    // Fail explicitly instead of saving a misleading course made from generic
    // placeholders. A learner should never be told a shallow module is ready.
    await store.updateJob(jobId, {
      stage: "error",
      completedStages: [...new Set(stages.slice(0, -1))],
      error: error instanceof Error ? error.message : "Course generation did not produce enough instructional material.",
    });
    return;
  }
}

app.get("/api/health", async (_req, res) => res.json({ ok: true, storage: storageStatus(), ollama: await checkOllama(), tavily: tavilyStatus() }));
app.get("/api/ollama/status", async (_req, res) => res.json(await checkOllama()));
app.get("/api/tavily/status", (_req, res) => res.json(tavilyStatus()));
app.get("/api/modules", (_req, res) => res.json({ modules: store.modules() }));
app.get("/api/modules/:id", (req, res) => {
  const module = store.getModule(req.params.id);
  if (!module) return res.status(404).json({ error: "Module not found" });
  return res.json({ module });
});
app.delete("/api/modules/:id", async (req, res) => {
  try {
    const deleted = await store.deleteModule(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Module not found" });
    return res.json({ deleted: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Unable to delete module" });
  }
});
app.post("/api/study/generate", async (req, res) => {
  const topic = safeText(req.body?.topic).trim();
  if (topic.length < 3) return res.status(400).json({ error: "Tell us what you want to learn." });
  const jobId = randomUUID();
  try {
    await store.addJob({ id: jobId, topic, stage: "understanding", completedStages: [], createdAt: new Date().toISOString() });
  } catch {
    return res.status(503).json({ error: "The study database is unavailable. Check DATABASE_URL and PostgreSQL, then restart the app." });
  }
  void runGeneration(jobId, topic, { goal: safeText(req.body?.goal, "General Learning"), difficulty: safeText(req.body?.difficulty, "Auto"), style: safeText(req.body?.style, "Balanced"), studyTime: safeText(req.body?.studyTime, "30 minutes/day"), researchDepth: safeText(req.body?.researchDepth, "basic") });
  return res.status(202).json({ jobId });
});
app.get("/api/study/jobs/:id", (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json({ job, stageLabels });
});
app.post("/api/tutor/chat", async (req, res) => {
  const mode = safeText(req.body?.mode, "tutor");
  const moduleId = safeText(req.body?.moduleId, "");
  const chapterId = safeText(req.body?.chapterId, "");
  const topic = safeText(req.body?.topic, "this topic");
  const chapterTitle = safeText(req.body?.chapter, "the current chapter");
  const question = safeText(req.body?.question).trim();
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  const effectiveQuestion = question || (attachments.length ? "Analyze the attached image." : "");
  if (!effectiveQuestion && !attachments.length) return res.status(400).json({ error: "Ask a question first." });

  if (mode === "general") {
    const skillLabel = safeText(req.body?.topic, safeText(req.body?.skill, "Core Operations Engineer"));
    const generalPrompt = [
      `You are a helpful, expert ${skillLabel} assistant. Return the answer in Markdown. Start with a one-line **Summary**, then provide a concise explanation. Use headings (##), numbered steps for procedures, and fenced code blocks (\`\`\`language) for any code samples. At the end include a brief "Next steps" section with suggestions or follow-ups. Be honest about uncertainty and suggest how the user can verify or continue researching. Keep personal details and memory private: do not narrate or announce that you remembered a name, role, company, topic, or preference unless the user explicitly asks for confirmation. Do not say things like "I have noted your name" or "I will remember this."`,
      `Student question: ${effectiveQuestion}`,
      attachments.length ? "The user attached one or more images. Incorporate them into your answer if relevant and describe what you observe." : "",
    ].join("\n");

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");
    await streamTutor(generalPrompt, res, attachments);
    return;
  }

  const module = moduleId ? store.getModule(moduleId) : null;
  const chapter = module && chapterId ? module.chapters.find((item) => item.id === chapterId) : module?.chapters[0];
  const chapterName = chapter?.title || chapterTitle || "the current chapter";
  const chapterDescription = chapter?.description || "No chapter description provided.";
  const lessonContext = chapter?.content?.detailedExplanation || chapter?.lesson || "";
  const chapterContent = chapter?.content || {};
  const keyTakeaways = Array.isArray(chapterContent.keyTakeaways) ? chapterContent.keyTakeaways : Array.isArray(chapter?.keyTakeaways) ? chapter.keyTakeaways : [];
  const currentObjectives = module?.objectives?.length ? module.objectives.slice(0, 5) : [];
  const concepts = Array.isArray(chapterContent.coreConcepts) ? chapterContent.coreConcepts.map((item: any) => `${item.title}: ${item.explanation}`).join("\n") : "";
  const procedures = Array.isArray(chapterContent.stepByStep) ? chapterContent.stepByStep.join("\n") : "";
  const sources = module?.sources?.length ? module.sources.slice(0, 10).map((source) => `${source.title} — ${source.url}`).join("\n") : "No verified sources are available.";

  // persist a lightweight conversation record (one-off) so tutor context can be retrieved later
  const convoId = randomUUID();
  try {
    if (moduleId) await store.addTutorConversation(convoId, moduleId || null, chapter?.id || chapterId || null, [{ role: "user", text: effectiveQuestion }]);
  } catch (err) { console.warn("Failed to persist tutor conversation metadata", err); }

  const prompt = [
    "You are a supportive AI tutor for a student in a structured study course.",
    `Module: ${module?.title || topic}`,
    `Topic: ${module?.topic || topic}`,
    `Current chapter: ${chapterName}`,
    `Chapter description: ${chapterDescription}`,
    currentObjectives.length ? `Learning objectives: ${currentObjectives.join("; ")}` : "Learning objectives: None provided",
    keyTakeaways.length ? `Key concepts already covered: ${keyTakeaways.slice(0, 5).join("; ")}` : "Key concepts: Not yet available",
    lessonContext ? `Relevant lesson context: ${lessonContext.slice(0, 1800)}` : "Relevant lesson context: Not available",
    concepts ? `Chapter concept explanations:\n${concepts.slice(0, 5000)}` : "",
    procedures ? `Chapter procedures:\n${procedures.slice(0, 3500)}` : "",
    `Verified module sources:\n${sources}`,
    `Learner progress: ${module ? `${module.progress}% overall; ${module.chapters.filter((item) => item.completed).length}/${module.chapters.length} chapters complete` : "unknown"}`,
    `Student question: ${effectiveQuestion}`,
    attachments.length ? "The user attached one or more images. Use them as context when relevant and explain what is visible." : "",
    "Return the answer in Markdown. Start with a one-line **Summary**, then provide a clear explanation. Use headings (##), a numbered 'Steps' list for procedures, and fenced code blocks (\`\`\`language) for any code samples. Cite relevant module content by name when used. End with a short 'Check for understanding' question and a 'Next steps' section with suggested follow-ups. If the module content is insufficient, explicitly say so and recommend what to read or ask next.",
  ].join("\n");

  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");
  await streamTutor(prompt, res, attachments);
});

// New endpoint: general chat with persistent user memory (long-term "brain")
app.post('/api/general/chat', async (req, res) => {
  const username = safeText(req.body?.username, "");
  const threadId = safeText(req.body?.threadId, "");
  const skillLabel = safeText(req.body?.topic, safeText(req.body?.skill, "Core Operations Engineer"));
  const question = safeText(req.body?.question).trim();
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments.filter((item: any) => typeof item === 'string' && item.trim().length > 0) : [];
  const effectiveQuestion = question || (attachments.length ? "Analyze the attached image." : "");
  if (!effectiveQuestion && !attachments.length) return res.status(400).json({ error: "Ask a question first." });

  // Load prior memory from the active thread (if provided) or fallback to legacy storage
  let priorMemory: any[] = [];
  let threadTitle: string | null = null;
  try {
    if (username && threadId && typeof store.getGeneralThread === 'function') {
      const stored = await store.getGeneralThread(username, threadId).catch(() => ({ convo: [], title: null }));
      priorMemory = Array.isArray(stored.convo) ? stored.convo : [];
      threadTitle = stored.title || null;
    } else if (username && typeof store.getGeneralConversation === 'function') {
      const stored = await store.getGeneralConversation(username).catch(() => ({ convo: [], createdAt: null }));
      priorMemory = Array.isArray(stored.convo) ? stored.convo : [];
    }
  } catch (err) {
    console.warn('Failed to load general memory', err);
    priorMemory = [];
  }

  let memorySection = "";
  if (priorMemory && priorMemory.length) {
    const recent = priorMemory.slice(-40).map((m: any) => `${m.role.toUpperCase()}: ${String(m.text).replace(/\n/g, ' ')}`);
    memorySection = `Previous conversation memory (most recent):\n${recent.join("\n")}\n\n`;
  }

  const systemContent = `You are a helpful, expert ${skillLabel} assistant. Return the answer in Markdown. Start with a one-line **Summary**, then provide a concise explanation. Use headings (##), numbered steps for procedures, and fenced code blocks (\`\`\`language) for any code samples. At the end include a brief "Next steps" section with suggestions or follow-ups. Be honest about uncertainty and suggest how the user can verify or continue researching. Keep personal details and memory private: do not narrate or announce that you remembered a name, role, company, topic, or preference unless the user explicitly asks for confirmation. Do not say things like "I have noted your name" or "I will remember this."`;

  const userPrompt = [memorySection, `Student question: ${effectiveQuestion}`, attachments.length ? "The user attached one or more images. Incorporate them into your answer if relevant and describe what you observe." : ""].join("\n");

  try {
    const assistantText = await generateText(systemContent, userPrompt, attachments);

    // Try to extract compact key points from the assistant reply for memory storage
    let keyPoints: string[] = [];
    try {
      const summarySchema = await generateJson<{ keyPoints: string[] }>(
        "You are a concise summarizer. Return only JSON: { \"keyPoints\": [ ... ] } with up to 8 short bullet points (8 words max each) that capture the important facts, suggestions, or action items from the assistant reply.",
        `Assistant reply:\n${assistantText}`,
      );
      if (summarySchema && Array.isArray((summarySchema as any).keyPoints)) {
        keyPoints = (summarySchema as any).keyPoints.map((k: any) => String(k).trim()).filter(Boolean).slice(0, 8);
      }
    } catch (summErr) {
      console.warn('Summarization for memory failed', summErr);
    }

    // Persist updated memory for the user (append user + assistant entries, plus compact keyPoints)
    try {
      if (username && threadId && typeof store.addGeneralThread === 'function') {
        const next = (Array.isArray(priorMemory) ? priorMemory.slice() : []);
        next.push({ role: 'user', text: effectiveQuestion, createdAt: new Date().toISOString() });
        next.push({ role: 'assistant', text: assistantText, createdAt: new Date().toISOString() });
        if (keyPoints.length) next.push({ role: 'memory', type: 'keypoints', items: keyPoints, createdAt: new Date().toISOString() });
        const bounded = next.slice(-2000);
        await store.addGeneralThread(username, threadId, threadTitle || 'Conversation', bounded).catch((e: any) => console.warn('Failed to persist general thread memory', e));
      } else if (username && typeof store.addGeneralConversation === 'function') {
        const next = (Array.isArray(priorMemory) ? priorMemory.slice() : []);
        next.push({ role: 'user', text: effectiveQuestion, createdAt: new Date().toISOString() });
        next.push({ role: 'assistant', text: assistantText, createdAt: new Date().toISOString() });
        if (keyPoints.length) next.push({ role: 'memory', type: 'keypoints', items: keyPoints, createdAt: new Date().toISOString() });
        const bounded = next.slice(-2000);
        await store.addGeneralConversation(username, bounded).catch((e: any) => console.warn('Failed to persist general conversation memory', e));
      }
    } catch (err) {
      console.warn('General conversation persistence failed', err);
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return res.status(200).send(String(assistantText));
  } catch (err) {
    console.error('General AI generation failed', err);
    return res.status(502).json({ error: 'General AI is currently unavailable. Check Ollama and try again.' });
  }
});

// Return stored general conversation memory for the current user (legacy single-conversation API)
app.get('/api/general/conversations', async (req, res) => {
  const username = safeText(req.query?.username || req.body?.username, "");
  if (!username) return res.status(400).json({ error: "username required" });
  try {
    if (typeof store.getGeneralConversation !== 'function') return res.json({ convo: [], createdAt: null });
    const stored = await store.getGeneralConversation(username).catch(() => ({ convo: [], createdAt: null }));
    return res.json({ convo: stored.convo || [], createdAt: stored.createdAt || null });
  } catch (err) {
    console.warn('Failed to read general conversations', err);
    return res.json({ convo: [], createdAt: null });
  }
});

// New: list threads for a user
app.get('/api/general/threads', async (req, res) => {
  const username = safeText(req.query?.username || req.body?.username, "");
  if (!username) return res.status(400).json({ error: "username required" });
  try {
    if (typeof store.listGeneralThreads !== 'function') return res.json({ threads: [] });
    const threads = await store.listGeneralThreads(username).catch(() => []);
    return res.json({ threads });
  } catch (err) {
    console.warn('Failed to list threads', err);
    return res.json({ threads: [] });
  }
});

// Create a new thread
app.post('/api/general/threads', async (req, res) => {
  const username = safeText(req.body?.username, "");
  const title = safeText(req.body?.title, 'New chat');
  if (!username) return res.status(400).json({ error: 'username required' });
  try {
    const id = randomUUID();
    if (typeof store.addGeneralThread === 'function') await store.addGeneralThread(username, id, title, []);
    return res.json({ id, title, createdAt: new Date().toISOString() });
  } catch (err) {
    console.error('Failed to create thread', err);
    return res.status(500).json({ error: 'Failed to create thread' });
  }
});

// Get a specific thread
app.get('/api/general/threads/:id', async (req, res) => {
  const username = safeText(req.query?.username || req.body?.username, "");
  const id = safeText(req.params.id || "");
  if (!username || !id) return res.status(400).json({ error: 'username and thread id required' });
  try {
    if (typeof store.getGeneralThread !== 'function') return res.json({ convo: [], title: null, createdAt: null });
    const thread = await store.getGeneralThread(username, id).catch(() => ({ convo: [], title: null, createdAt: null }));
    return res.json(thread);
  } catch (err) {
    console.warn('Failed to read thread', err);
    return res.json({ convo: [], title: null, createdAt: null });
  }
});

// Update (save) a thread's convo
app.post('/api/general/threads/:id', async (req, res) => {
  const username = safeText(req.body?.username || req.query?.username, "");
  const id = safeText(req.params.id || "");
  const convo = Array.isArray(req.body?.convo) ? req.body.convo : [];
  const title = safeText(req.body?.title, 'Conversation');
  if (!username || !id) return res.status(400).json({ error: 'username and thread id required' });
  try {
    if (typeof store.addGeneralThread !== 'function') return res.status(503).json({ error: 'Thread storage not available' });
    await store.addGeneralThread(username, id, title, convo);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Failed to save thread', err);
    return res.status(500).json({ error: 'Failed to save thread' });
  }
});

// Delete a thread
app.delete('/api/general/threads/:id', async (req, res) => {
  const username = safeText(req.query?.username || req.body?.username, "");
  const id = safeText(req.params.id || "");
  if (!username || !id) return res.status(400).json({ error: 'username and thread id required' });
  try {
    if (typeof store.deleteGeneralThread !== 'function') return res.status(503).json({ error: 'Thread storage not available' });
    await store.deleteGeneralThread(username, id);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Failed to delete thread', err);
    return res.status(500).json({ error: 'Failed to delete thread' });
  }
});

// Persistent per-user 'brain' endpoints (structured memory)
app.get('/api/general/brain', async (req, res) => {
  const username = safeText(req.query?.username || req.body?.username, "");
  if (!username) return res.status(400).json({ error: "username required" });
  try {
    if (typeof store.getGeneralBrain !== 'function') return res.json({ data: {} });
    const stored = await store.getGeneralBrain(username).catch(() => ({ data: {}, updatedAt: null }));
    return res.json({ data: stored.data || {}, updatedAt: stored.updatedAt || null });
  } catch (err) {
    console.warn('Failed to read general brain', err);
    return res.json({ data: {} });
  }
});

app.post('/api/general/brain', async (req, res) => {
  const username = safeText(req.body?.username, "");
  const data = req.body?.data || {};
  if (!username) return res.status(400).json({ error: 'username required' });
  try {
    if (typeof store.addGeneralBrain !== 'function') return res.status(503).json({ error: 'Brain storage not available' });
    await store.addGeneralBrain(username, data);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Failed to save general brain', err);
    return res.status(500).json({ error: 'Failed to save brain' });
  }
});

app.delete('/api/general/brain', async (req, res) => {
  const username = safeText(req.query?.username || req.body?.username, "");
  if (!username) return res.status(400).json({ error: 'username required' });
  try {
    if (typeof store.deleteGeneralBrain !== 'function') return res.status(503).json({ error: 'Brain storage not available' });
    await store.deleteGeneralBrain(username);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Failed to delete general brain', err);
    return res.status(500).json({ error: 'Failed to delete brain' });
  }
});

app.post('/api/modules/:id/enhance', async (req, res) => {
  const startedAt = Date.now();
  const tag = req.params.id.slice(0, 8);
  const log = (message: string) => console.log(`[study][enhance:${tag}] ${message} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
  try {
    const module = store.getModule(req.params.id);
    if (!module) return res.status(404).json({ error: 'Module not found' });
    const sourceContext = module.sources.length
      ? module.sources.map((source) => `${source.title} (${source.url}): ${source.snippet}`).join('\n').slice(0, 24000)
      : 'No verified web sources were available.';
    const enhancedChapters = [...module.chapters];
    for (const [index, chapter] of module.chapters.entries()) {
      log(`chapter ${index + 1}/${module.chapters.length} started: ${chapter.title}`);
      const prior = module.chapters.slice(0, index).map((item, i) => `${i + 1}. ${item.title}: ${item.description}`).join('\n') || 'None';
      const following = module.chapters.slice(index + 1).map((item, i) => `${index + i + 2}. ${item.title}: ${item.description}`).join('\n') || 'None';
      const system = `You are upgrading an existing course chapter into actual study material. Return JSON only. Do not return an outline, introduction-only advice, placeholders, or a rewrite that merely changes wording. Preserve accurate existing material, then add teaching depth. Include: why, learningObjectives (4-6), prerequisites, intro, concept, workedExample, exercise, recap, detailedExplanation (at least 3000 characters and multiple paragraphs), coreConcepts (8-12 objects with title and detailed explanation), stepByStep (8+ concrete steps), realWorldExamples (4+), practicalExamples (4+), technicalExamples (2+ when relevant), commonMistakes (5+), troubleshooting (4+), bestPractices (5+), importantTerms (8+ term/definition objects), keyTakeaways (6+), visualExplanation, practicalExercise with success criteria, scenarioExercise, quickQuiz (8+ with correct answers and explanations), and furtherReading. Every major concept needs definition, why it matters, an example, a misconception, and a way to practice it.`;
      const prompt = `Course: ${module.title}\nTopic: ${module.topic}\nChapter ${index + 1} of ${module.chapters.length}: ${chapter.title}\nPurpose: ${chapter.description}\nPrevious chapters:\n${prior}\nFollowing chapters:\n${following}\nExisting chapter material to improve:\n${JSON.stringify(chapter.content || chapter).slice(0, 18000)}\nResearch sources:\n${sourceContext}\nWrite the complete upgraded chapter so a learner can study it without searching elsewhere for basic understanding.`;
      let upgraded: Record<string, any> | null = null;
      for (let attempt = 1; attempt <= 3 && !upgraded; attempt += 1) {
        log(`chapter ${index + 1} attempt ${attempt}/3: requesting expanded lesson`);
        const generated = await generateJson<unknown>(system, prompt);
        const candidate = normalizeChapterContent(generated as Record<string, unknown>, module.topic, chapter.title, chapter.description);
        const valid = candidate.detailedExplanation.trim().length >= 2200
          && candidate.coreConcepts.length >= 6
          && candidate.stepByStep.length >= 6
          && candidate.quickQuiz.length >= 5;
        log(`chapter ${index + 1} attempt ${attempt}: ${candidate.detailedExplanation.length} chars, ${candidate.coreConcepts.length} concepts, ${candidate.quickQuiz.length} quiz`);
        if (valid) upgraded = candidate;
        else if (attempt === 3) throw new Error(`Chapter "${chapter.title}" could not be expanded into complete study material.`);
      }
      enhancedChapters[index] = {
        ...chapter,
        lesson: upgraded!.detailedExplanation.slice(0, 4000),
        keyTakeaways: upgraded!.keyTakeaways.slice(0, 8),
        example: upgraded!.realWorldExamples[0] || chapter.example,
        practicePrompt: upgraded!.practicalExercise || chapter.practicePrompt,
        content: upgraded!,
      };
      await store.updateModule(module.id, { chapters: enhancedChapters });
      log(`chapter ${index + 1}/${module.chapters.length} saved`);
    }
    return res.json({ module: store.getModule(module.id) });
  } catch (err) {
    console.error(`[study][enhance] failed for ${req.params.id}`, err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to enhance course' });
  }
});

app.post("/api/modules/:id/chapters/:chapterId/complete", async (req, res) => {
  const module = store.getModule(req.params.id);
  if (!module) return res.status(404).json({ error: "Module not found" });
  const chapters = module.chapters.map((chapter) => chapter.id === req.params.chapterId ? { ...chapter, completed: true } : chapter);
  const progress = Math.round((chapters.filter((chapter) => chapter.completed).length / chapters.length) * 100);
  try {
    await store.updateModule(module.id, { chapters, progress });
  } catch {
    return res.status(503).json({ error: "The study database is unavailable. Check DATABASE_URL and PostgreSQL, then restart the app." });
  }
  return res.json({ module: store.getModule(module.id) });
});

// Exams: pre and final
app.get('/api/modules/:id/pre-exam', async (req, res) => {
  try {
    const result = process.env.DATABASE_URL ? await getExamByModule(req.params.id, 'pre') : null;
    if (!result) return res.status(404).json({ error: 'Pre-exam not found' });
    // do not expose correct answers to the client
    const questions = result.questions.map((q: any) => ({ id: q.id, question: q.question, type: q.type, options: q.options || null, difficulty: q.difficulty, chapterId: q.chapterId, conceptId: q.conceptId }));
    return res.json({ exam: { id: result.exam.id, title: result.exam.title, description: result.exam.description, totalQuestions: result.exam.totalQuestions }, questions });
  } catch (err) { console.error(err); return res.status(500).json({ error: 'Unable to load pre-exam' }); }
});

app.post('/api/modules/:id/pre-exam/submit', async (req, res) => {
  try {
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const scoring = await scoreExam(req.params.id, 'pre', answers);
    const module = store.getModule(req.params.id);
    if (module) await store.updateModule(module.id, { preExamScore: Math.round(scoring.score * 100) });
    return res.json(scoring);
  } catch (err) { console.error(err); return res.status(500).json({ error: 'Unable to submit pre-exam' }); }
});

app.get('/api/modules/:id/final-exam', async (req, res) => {
  try {
    const result = process.env.DATABASE_URL ? await getExamByModule(req.params.id, 'final') : null;
    if (!result) return res.status(404).json({ error: 'Final exam not found' });
    const questions = result.questions.map((q: any) => ({ id: q.id, question: q.question, type: q.type, options: q.options || null, difficulty: q.difficulty, chapterId: q.chapterId, conceptId: q.conceptId }));
    return res.json({ exam: { id: result.exam.id, title: result.exam.title, description: result.exam.description, totalQuestions: result.exam.totalQuestions }, questions });
  } catch (err) { console.error(err); return res.status(500).json({ error: 'Unable to load final exam' }); }
});

app.post('/api/modules/:id/final-exam/submit', async (req, res) => {
  try {
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const scoring = await scoreExam(req.params.id, 'final', answers);
    const module = store.getModule(req.params.id);
    if (module) await store.updateModule(module.id, { finalScore: Math.round(scoring.score * 100) });
    return res.json(scoring);
  } catch (err) { console.error(err); return res.status(500).json({ error: 'Unable to submit final exam' }); }
});

// Flashcards
app.get('/api/modules/:id/flashcards', async (req, res) => {
  try {
    if (process.env.DATABASE_URL) {
      const cards = await getFlashcardsByModule(req.params.id);
      return res.json({ flashcards: cards });
    }
    const module = store.getModule(req.params.id);
    if (!module) return res.status(404).json({ error: 'Module not found' });
    const cards: any[] = [];
    for (const ch of module.chapters) {
      const k = ch.keyTakeaways || [];
      for (const [i, takeaway] of k.entries()) cards.push({ id: `${module.id}-fc-${ch.id}-${i}`, moduleId: module.id, chapterId: ch.id, question: `Recall: ${takeaway.split('.')[0]}`, answer: takeaway, difficulty: 'medium' });
    }
    return res.json({ flashcards: cards });
  } catch (err) { console.error(err); return res.status(500).json({ error: 'Unable to load flashcards' }); }
});

app.post('/api/flashcards/:id/review', async (req, res) => {
  try {
    const rating = safeText(req.body?.rating, 'good') as 'again' | 'hard' | 'good' | 'easy';
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Flashcard reviews require PostgreSQL storage' });
    const result = await recordFlashcardReview(req.params.id, { rating });
    return res.json(result);
  } catch (err) { console.error(err); return res.status(500).json({ error: 'Unable to record review' }); }
});

// Regeneration endpoints: per-component regeneration without rebuilding whole module
app.post('/api/modules/:id/regenerate/chapter/:chapterId', async (req, res) => {
  try {
    const module = store.getModule(req.params.id);
    if (!module) return res.status(404).json({ error: 'Module not found' });
    const chapter = module.chapters.find((c) => c.id === req.params.chapterId);
    if (!chapter) return res.status(404).json({ error: 'Chapter not found' });

    const chapterSystem = `You are a professional instructor revising one chapter inside a sequential full course. Return JSON only with why, learningObjectives, prerequisites, intro, concept, workedExample, exercise, recap, detailedExplanation, coreConcepts, stepByStep, realWorldExamples, practicalExamples, technicalExamples, commonMistakes, troubleshooting, bestPractices, importantTerms, keyTakeaways, visualExplanation, practicalExercise, scenarioExercise, quickQuiz, and furtherReading. Make detailedExplanation multi-paragraph and substantial (normally 3000-6000 characters), teach 6-10 connected concepts, define terms, explain why they matter, show examples and applications, address misconceptions, and give a solvable exercise with success criteria. Include at least 6 meaningful quiz questions with answers and explanations. Connect this chapter to the preceding and following chapters supplied in the prompt. Do not return an outline, generic advice, or introductory sentences only.`;
    const sourceContext = module.sources.length ? module.sources.map((s) => `${s.title} (${s.url}): ${s.snippet}`).join('\n') : '';
    const chapterIndex = module.chapters.findIndex((item) => item.id === chapter.id);
    const previousChapters = module.chapters.slice(0, chapterIndex).map((item, index) => `${index + 1}. ${item.title}: ${item.description}`).join("\n") || "None — foundation chapter.";
    const followingChapters = module.chapters.slice(chapterIndex + 1).map((item, index) => `${chapterIndex + index + 2}. ${item.title}: ${item.description}`).join("\n") || "None — final chapter.";
    const chapterPrompt = `Course: ${module.title}\nTopic: ${module.topic}\nCourse objectives: ${module.objectives.join("; ")}\nChapter ${chapterIndex + 1} of ${module.chapters.length}: ${chapter.title}\nChapter purpose: ${chapter.description}\nPrevious chapters:\n${previousChapters}\nFollowing chapters:\n${followingChapters}\nResearch:\n${sourceContext}`;

    let content: Record<string, any> | null = null;
    let attempt = 0;
    let success = false;
    while (attempt < 3 && !success) {
      attempt += 1;
      try {
        const generated = await generateJson<unknown>(chapterSystem, chapterPrompt);
        const candidate = normalizeChapterContent(generated as Record<string, unknown> | null, module.topic, chapter.title, chapter.description);
        if (!candidate || (typeof candidate.detailedExplanation !== 'string' && !Array.isArray(candidate.coreConcepts) && !(Array.isArray(candidate.keyTakeaways) && candidate.keyTakeaways.length > 0))) {
          throw new Error('Generated chapter did not include sufficient instructional material');
        }
        content = candidate;
        success = true;
      } catch (err) {
        if (attempt >= 3) {
          content = normalizeChapterContent({ detailedExplanation: `Expanded lesson for ${chapter.title}: ${chapter.description}\n\n(Generation failed after retries.)`, keyTakeaways: [chapter.description], intro: `In this chapter, you will learn the core ideas behind ${chapter.title}.`, concept: `The concept is to understand ${chapter.title} in practice and connect it to the topic as a whole.`, workedExample: `A worked example shows how ${chapter.title} can be applied in a realistic scenario.`, exercise: `Practice by explaining ${chapter.title} in your own words and applying it to a concrete task.`, recap: `The recap reinforces the main takeaway: understand the idea, apply it, and check your own understanding.` }, module.topic, chapter.title, chapter.description);
          success = true;
        } else {
          await delay(400);
        }
      }
    }

    if (!content) throw new Error('Chapter content is missing after regeneration');
    const regeneratedLength = typeof content.detailedExplanation === 'string' ? content.detailedExplanation.trim().length : 0;
    if (
      regeneratedLength < 2200
      || !Array.isArray(content.coreConcepts) || content.coreConcepts.length < 6
      || !Array.isArray(content.stepByStep) || content.stepByStep.length < 6
      || !Array.isArray(content.quickQuiz) || content.quickQuiz.length < 5
    ) {
      throw new Error('Regenerated chapter was too shallow. Ollama must return a complete readable lesson before it can replace the chapter.');
    }
    const updatedChapter = { ...chapter, lesson: typeof content.detailedExplanation === 'string' ? content.detailedExplanation.slice(0, 4000) : chapter.lesson, keyTakeaways: Array.isArray(content.keyTakeaways) ? content.keyTakeaways.slice(0, 8) : chapter.keyTakeaways, example: Array.isArray(content.realWorldExamples) && content.realWorldExamples.length ? content.realWorldExamples[0] : chapter.example, practicePrompt: content.practicalExercise ?? chapter.practicePrompt, content };
    const nextChapters = module.chapters.map((c) => c.id === chapter.id ? updatedChapter : c);
    await store.updateModule(module.id, { chapters: nextChapters });
    return res.json({ chapter: updatedChapter });
  } catch (err) { console.error(err); return res.status(500).json({ error: 'Failed to regenerate chapter' }); }
});

app.post('/api/modules/:id/regenerate/videos', async (req, res) => {
  try {
    const module = store.getModule(req.params.id);
    if (!module) return res.status(404).json({ error: 'Module not found' });
    const depth = safeText(req.body?.researchDepth, 'basic');
    const mappedVideos = await collectChapterVideos(module, module.topic, depth);

    await store.updateModule(module.id, { videos: mappedVideos });
    return res.json({ videos: mappedVideos });
  } catch (err) { console.error(err); return res.status(500).json({ error: 'Failed to regenerate videos' }); }
});

app.post('/api/modules/:id/regenerate/flashcards', async (req, res) => {
  try {
    const module = store.getModule(req.params.id);
    if (!module) return res.status(404).json({ error: 'Module not found' });
    const flashcards: any[] = [];
    for (const ch of module.chapters) {
      const content = ch.content || {};
      const concepts = Array.isArray(content.coreConcepts) ? content.coreConcepts : [];
      const terms = Array.isArray(content.importantTerms) ? content.importantTerms : [];
      const takeaways = ch.keyTakeaways || content.keyTakeaways || [];
       concepts.slice(0, 12).forEach((concept: any, i) => {
        if (concept?.title && concept?.explanation) flashcards.push({ id: `${module.id}-fc-${ch.id}-concept-${i}`, moduleId: module.id, chapterId: ch.id, conceptId: `${ch.id}-concept-${i}`, question: `Explain ${concept.title} and why it matters in ${ch.title}.`, answer: concept.explanation, difficulty: i < 2 ? 'medium' : 'hard' });
      });
       terms.slice(0, 12).forEach((term: any, i) => {
        if (term?.term && term?.definition) flashcards.push({ id: `${module.id}-fc-${ch.id}-term-${i}`, moduleId: module.id, chapterId: ch.id, conceptId: `${ch.id}-term-${i}`, question: `What is ${term.term}?`, answer: term.definition, difficulty: 'medium' });
      });
      if (!concepts.length && !terms.length) takeaways.slice(0, 5).forEach((takeaway, i) => flashcards.push({ id: `${module.id}-fc-${ch.id}-takeaway-${i}`, moduleId: module.id, chapterId: ch.id, conceptId: `${ch.id}-takeaway-${i}`, question: `Explain this idea from ${ch.title}: ${takeaway.split('.')[0]}`, answer: takeaway, difficulty: 'medium' }));
    }
    if (flashcards.length) await store.addFlashcards(flashcards);
    return res.json({ flashcards });
  } catch (err) { console.error(err); return res.status(500).json({ error: 'Failed to regenerate flashcards' }); }
});

app.post('/api/modules/:id/regenerate/pre-exam', async (req, res) => {
  try {
    const module = store.getModule(req.params.id);
    if (!module) return res.status(404).json({ error: 'Module not found' });
    const preExamSystem = `You are an expert diagnostic assessment author. Generate approximately 10 prerequisite-focused questions for a course. Mix multiple choice, true/false, short answer, and scenarios to expose prior knowledge and misconceptions. Do not make this a final exam. Return JSON only: {id,title,description,questions:[{id,question,type,options,correctAnswer,explanation,conceptId,difficulty}]}.`;
    const preExamPrompt = `Module: ${module.title}\nTopic: ${module.topic}\nObjectives: ${module.objectives.join('; ')}\nChapters in order:\n${module.chapters.map((c, i) => `${i + 1}. ${c.title}: ${c.description}`).join('\n')}\nAssess only the foundations needed to begin this course.`;
    const preExam = await generateJson<any>(preExamSystem, preExamPrompt);
    if (preExam && validAssessmentQuestions(preExam.questions, 10)) {
      await store.addExam({ id: preExam.id || `${module.id}-pre`, moduleId: module.id, type: 'pre', title: preExam.title || 'Pre-Exam', description: preExam.description || 'Diagnostic test', totalQuestions: preExam.questions.length }, preExam.questions.map((q: any, idx: number) => ({ id: q.id || `${module.id}-pre-q-${idx}`, question: q.question, type: q.type, options: q.options || null, correctAnswer: q.correctAnswer || null, explanation: q.explanation || null, difficulty: q.difficulty || 'medium', chapterId: q.chapterId ?? null, conceptId: q.conceptId ?? null, sortOrder: idx })));
    } else throw new Error('Pre-exam must contain at least 10 complete questions with answer keys and explanations.');
    return res.json({ ok: true });
  } catch (err) { console.error(err); return res.status(500).json({ error: 'Failed to regenerate pre-exam' }); }
});

app.post('/api/modules/:id/regenerate/final-exam', async (req, res) => {
  try {
    const module = store.getModule(req.params.id);
    if (!module) return res.status(404).json({ error: 'Module not found' });
    const finalExamSystem = `You are an expert assessment author. Generate a comprehensive FINAL EXAM with 20 new questions from the complete course. Do not copy or concatenate chapter quizzes. Cover every major chapter and objective with conceptual, application, troubleshooting, scenario, and difficult analysis questions. Include correctAnswer and explanation for every question. Return JSON only: {id,title,description,questions:[{id,question,type,options,correctAnswer,explanation,conceptId,difficulty}]}.`;
    const finalExamPrompt = `Module: ${module.title}\nTopic: ${module.topic}\nObjectives: ${module.objectives.join('; ')}\nComplete course content:\n${module.chapters.map((c, i) => {
      const content = c.content || {};
      const concepts = Array.isArray(content.coreConcepts) ? content.coreConcepts.map((item: any) => item.title).join(', ') : '';
      return `Chapter ${i + 1}: ${c.title}\nPurpose: ${c.description}\nConcepts taught: ${concepts}\nKey takeaways: ${(c.keyTakeaways || []).join('; ')}`;
    }).join('\n')}`;
    const finalExam = await generateJson<any>(finalExamSystem, finalExamPrompt);
    if (finalExam && validAssessmentQuestions(finalExam.questions, 20)) {
      await store.addExam({ id: finalExam.id || `${module.id}-final`, moduleId: module.id, type: 'final', title: finalExam.title || 'Final Exam', description: finalExam.description || 'Final test', totalQuestions: finalExam.questions.length }, finalExam.questions.map((q: any, idx: number) => ({ id: q.id || `${module.id}-final-q-${idx}`, question: q.question, type: q.type, options: q.options || null, correctAnswer: q.correctAnswer || null, explanation: q.explanation || null, difficulty: q.difficulty || 'hard', chapterId: q.chapterId ?? null, conceptId: q.conceptId ?? null, sortOrder: idx })));
    } else throw new Error('Final exam must contain at least 20 complete scenario-ready questions with answer keys and explanations.');
    return res.json({ ok: true });
  } catch (err) { console.error(err); return res.status(500).json({ error: 'Failed to regenerate final exam' }); }
});

// Helper to fetch exam and questions (without exposing answers)
async function getExamWrapper(moduleId: string, type: string) {
  if (!process.env.DATABASE_URL) return null;
  const result = await getExamByModule(moduleId, type);
  if (!result) return null;
  return result;
}

// Score an exam submission. Answers is array of { questionId, answer }
async function scoreExam(moduleId: string, type: string, answers: { questionId: string; answer: any }[]) {
  if (!process.env.DATABASE_URL) return { score: 0, total: 0, correct: 0, incorrect: 0, details: [] };
  const payload = await getExamByModule(moduleId, type);
  if (!payload) return { score: 0, total: 0, correct: 0, incorrect: 0, details: [] };
  const questions = payload.questions as any[];
  const qmap = new Map(questions.map((q) => [q.id, q]));
  let correct = 0;
  const details: any[] = [];
  for (const ans of answers) {
    const q = qmap.get(ans.questionId);
    if (!q) continue;
    const expected = q.correctanswer ?? q.correctAnswer ?? q.correct_answer ?? null;
    let isCorrect = false;
    try {
      if (expected == null) { isCorrect = false; }
      else if (typeof expected === 'string' || typeof expected === 'number') { isCorrect = String(expected).trim().toLowerCase() === String(ans.answer).trim().toLowerCase(); }
      else { isCorrect = JSON.stringify(expected) === JSON.stringify(ans.answer); }
    } catch { isCorrect = false; }
    if (isCorrect) correct += 1;
    details.push({ questionId: ans.questionId, correct: isCorrect, expected, provided: ans.answer, explanation: q.explanation });
  }
  const total = questions.length;
  const score = total ? (correct / total) : 0;
  return { score, total, correct, incorrect: total - correct, details };
}

await initializeStore();

const port = Number(process.env.PORT || 5000);const server = createServer(app);
const vite = await createViteServer({ server: { middlewareMode: true, hmr: { server }, allowedHosts: true }, appType: "spa" });
app.use(vite.middlewares);
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.status(404).end();
});
server.listen(port, "0.0.0.0", () => console.log(`Study Lab listening on ${port}`));
process.once("SIGTERM", () => { void closeStore(); });
process.once("SIGINT", () => { void closeStore(); });