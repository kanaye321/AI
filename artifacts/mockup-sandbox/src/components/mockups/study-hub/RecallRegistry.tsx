import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  Circle,
  Clock3,
  Command,
  Flame,
  Gauge,
  Layers3,
  LayoutGrid,
  Menu,
  Pause,
  Play,
  Plus,
  Search,
  Sparkles,
  Target,
  TimerReset,
  TrendingUp,
  X,
} from "lucide-react";
import "./RecallRegistry.css";

type RegistryTask = {
  id: number;
  title: string;
  course: string;
  kind: string;
  minutes: number;
  accent: "lime" | "rust" | "sky" | "ochre";
  done: boolean;
};

const initialTasks: RegistryTask[] = [
  { id: 1, title: "Map the Azure identity model", course: "AZ-104 · Identity & governance", kind: "DEEP READ", minutes: 24, accent: "lime", done: false },
  { id: 2, title: "Recall: role-based access control", course: "AZ-104 · Identity & governance", kind: "RECALL SET", minutes: 8, accent: "sky", done: true },
  { id: 3, title: "Explain subnet delegation in one minute", course: "Network troubleshooting", kind: "TEACH-BACK", minutes: 12, accent: "ochre", done: false },
  { id: 4, title: "Review the 3 missed concepts", course: "Python fundamentals", kind: "TARGETED REVIEW", minutes: 16, accent: "rust", done: false },
];

const navItems = [
  { label: "Today", icon: LayoutGrid },
  { label: "Library", icon: BookOpen },
  { label: "Recall", icon: Layers3 },
  { label: "Insights", icon: TrendingUp },
];

export function RecallRegistry() {
  const [activeNav, setActiveNav] = useState("Today");
  const [tasks, setTasks] = useState(initialTasks);
  const [query, setQuery] = useState("");
  const [focusTask, setFocusTask] = useState<RegistryTask | null>(null);
  const [running, setRunning] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [sortMode, setSortMode] = useState("Recommended");

  const visibleTasks = useMemo(() => {
    const searched = tasks.filter((task) => `${task.title} ${task.course}`.toLowerCase().includes(query.toLowerCase()));
    if (sortMode === "Shortest first") return [...searched].sort((a, b) => a.minutes - b.minutes);
    if (sortMode === "Unfinished") return searched.filter((task) => !task.done);
    return searched;
  }, [query, sortMode, tasks]);

  const completed = tasks.filter((task) => task.done).length;
  const nextTask = tasks.find((task) => !task.done) ?? tasks[0];
  const openSession = () => setFocusTask({ id: 99, title: "A fresh study sprint", course: "Personal focus", kind: "OPEN SESSION", minutes: 20, accent: "lime", done: false });

  function toggleTask(id: number) {
    setTasks((current) => current.map((task) => (task.id === id ? { ...task, done: !task.done } : task)));
  }

  function startTask(task: RegistryTask) {
    setFocusTask(task);
    setRunning(true);
  }

  return (
    <div className="recall-registry">
      <aside className={`registry-rail ${menuOpen ? "registry-rail--open" : ""}`}>
        <div className="registry-brand">
          <div className="registry-brand-mark"><Sparkles size={15} strokeWidth={2.6} /></div>
          <span>studylab <i>/ registry</i></span>
          <button className="registry-icon registry-close-mobile" onClick={() => setMenuOpen(false)} aria-label="Close navigation"><X size={16} /></button>
        </div>
        <button className="registry-new" onClick={openSession}><Plus size={15} /> New session</button>
        <div className="registry-rail-label">Your desk</div>
        <nav className="registry-nav" aria-label="Study desk navigation">
          {navItems.map(({ label, icon: Icon }) => (
            <button className={`registry-nav-item ${activeNav === label ? "is-active" : ""}`} onClick={() => { setActiveNav(label); setMenuOpen(false); }} key={label}>
              <Icon size={16} /><span>{label}</span>{label === "Today" && <span className="registry-nav-count">{tasks.length - completed}</span>}
            </button>
          ))}
        </nav>
        <div className="registry-rail-label registry-rail-label--space">Pinned paths</div>
        <button className="registry-path" onClick={() => setQuery("AZ-104")}>
          <span className="registry-swatch registry-swatch--lime"></span><span><strong>AZ-104</strong><small>4 chapters open</small></span><ArrowUpRight size={13} />
        </button>
        <button className="registry-path" onClick={() => setQuery("Python")}>
          <span className="registry-swatch registry-swatch--sky"></span><span><strong>Python fundamentals</strong><small>2 chapters open</small></span><ArrowUpRight size={13} />
        </button>
        <div className="registry-rail-bottom">
          <div className="registry-rail-tip"><Brain size={15} /><div><strong>Small beats heroic.</strong><p>Twenty focused minutes is enough for today.</p></div></div>
          <button className="registry-account"><span className="registry-avatar">AL</span><span><strong>Alex Morgan</strong><small>Personal workspace</small></span><ChevronDown size={14} /></button>
        </div>
      </aside>

      <main className="registry-main">
        <header className="registry-topbar">
          <button className="registry-icon registry-menu-button" onClick={() => setMenuOpen(true)} aria-label="Open navigation"><Menu size={18} /></button>
          <div className="registry-breadcrumb"><span>Tuesday, August 18</span><b>/</b><strong>{activeNav}</strong></div>
          <div className="registry-top-actions">
            <button className="registry-search-button" onClick={() => setShowSearch((value) => !value)}><Search size={15} /><span>Find anything</span><kbd><Command size={10} /> K</kbd></button>
            <button className="registry-icon" aria-label="Notifications"><Circle size={15} /></button>
            <span className="registry-avatar registry-avatar--small">AL</span>
          </div>
        </header>

        <div className="registry-content">
          <section className="registry-intro">
            <div>
              <div className="registry-overline"><span className="registry-live-dot"></span> YOUR STUDY DESK · 08.18</div>
              <h1>Keep the signal.<br /><em>Lose the noise.</em></h1>
              <p>A considered queue for the work that deserves your attention today.</p>
            </div>
            <div className="registry-intro-orbit" aria-hidden="true">
              <div className="registry-ring registry-ring--one"></div><div className="registry-ring registry-ring--two"></div>
              <div className="registry-orbit-core"><Gauge size={22} /><strong>{Math.round((completed / tasks.length) * 100)}%</strong><span>logged today</span></div>
              <i className="registry-orbit-dot registry-orbit-dot--one"></i><i className="registry-orbit-dot registry-orbit-dot--two"></i>
            </div>
          </section>

          {showSearch && (
            <div className="registry-search-popover">
              <Search size={15} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your paths and sessions..." /><button className="registry-icon" onClick={() => { setQuery(""); setShowSearch(false); }} aria-label="Clear search"><X size={15} /></button>
            </div>
          )}

          <div className="registry-stats">
            <div className="registry-stat registry-stat--warm"><span className="registry-stat-icon"><Flame size={15} /></span><div><strong>4 days</strong><small>current rhythm</small></div><b>+1</b></div>
            <div className="registry-stat registry-stat--cool"><span className="registry-stat-icon"><Clock3 size={15} /></span><div><strong>18 min</strong><small>in the zone this week</small></div><b>steady</b></div>
            <div className="registry-stat registry-stat--quiet"><span className="registry-stat-icon"><Target size={15} /></span><div><strong>{completed} of {tasks.length}</strong><small>today's sessions</small></div><b>{completed === tasks.length ? "done" : "open"}</b></div>
          </div>

          <div className="registry-grid">
            <section className="registry-queue">
              <div className="registry-section-head">
                <div><div className="registry-overline registry-overline--ink">THE NEXT RIGHT THING</div><h2>Your queue</h2></div>
                <div className="registry-sort"><select value={sortMode} onChange={(event) => setSortMode(event.target.value)} aria-label="Sort sessions"><option>Recommended</option><option>Shortest first</option><option>Unfinished</option></select><ChevronDown size={13} /></div>
              </div>
              <div className="registry-queue-list">
                {visibleTasks.map((task, index) => (
                  <article className={`registry-task ${task.done ? "is-done" : ""}`} key={task.id}>
                    <button className={`registry-task-check registry-task-check--${task.accent}`} onClick={() => toggleTask(task.id)} aria-label={task.done ? `Mark ${task.title} incomplete` : `Mark ${task.title} complete`}>{task.done && <Check size={12} />}</button>
                    <button className="registry-task-copy" onClick={() => startTask(task)}><span className="registry-task-index">0{index + 1}</span><span><strong>{task.title}</strong><small>{task.course}</small></span></button>
                    <span className="registry-task-kind">{task.kind}</span><span className="registry-task-time"><Clock3 size={12} /> {task.minutes}m</span>
                    <button className="registry-task-play" onClick={() => startTask(task)} aria-label={`Start ${task.title}`}><Play size={13} fill="currentColor" /></button>
                  </article>
                ))}
                {visibleTasks.length === 0 && <div className="registry-empty"><Search size={21} /><strong>No sessions match that search.</strong><button onClick={() => { setQuery(""); setSortMode("Recommended"); }}>Clear filters</button></div>}
              </div>
              <button className="registry-add" onClick={openSession}><Plus size={14} /> Add a session to the queue</button>
            </section>

            <aside className="registry-side-stack">
              <section className="registry-panel registry-next">
                <div className="registry-overline">PICK UP WHERE YOU LEFT OFF</div>
                <div className="registry-next-art"><div className="registry-next-letter">AZ</div><div className="registry-next-lines"></div><span>62% through</span></div>
                <h3>Azure identity & access</h3><p>Chapter 03 · Service principals</p>
                <div className="registry-progress"><span style={{ width: "62%" }}></span></div>
                <button className="registry-primary" onClick={() => nextTask && startTask(nextTask)}>Continue chapter <ArrowUpRight size={14} /></button>
              </section>
              <section className="registry-panel registry-insight">
                <div className="registry-panel-head"><div className="registry-overline">A NOTE FROM YOUR DATA</div><Sparkles size={15} /></div>
                <h3>Your recall is strongest before lunch.</h3><p>You answer 23% more accurately in the first hour of your study day. Keep the hard concept first.</p>
                <button className="registry-text-button" onClick={() => setActiveNav("Insights")}>Open insights <ArrowUpRight size={13} /></button>
              </section>
            </aside>
          </div>
        </div>
      </main>

      {focusTask && (
        <div className="registry-modal-backdrop" onMouseDown={() => setFocusTask(null)}>
          <section className="registry-session-modal" onMouseDown={(event) => event.stopPropagation()}>
            <button className="registry-modal-close registry-icon" onClick={() => setFocusTask(null)} aria-label="Close focus session"><X size={16} /></button>
            <div className="registry-overline registry-overline--ink">FOCUS SESSION · {focusTask.kind}</div>
            <div className="registry-session-top"><span className={`registry-session-pip registry-session-pip--${focusTask.accent}`}></span><span>{focusTask.course}</span></div>
            <h2>{focusTask.title}</h2>
            <div className="registry-session-timer"><strong>{running ? "18:00" : "00:00"}</strong><span>{running ? "deep work in progress" : "ready when you are"}</span></div>
            <div className="registry-session-actions">
              <button className="registry-secondary" onClick={() => setRunning((value) => !value)}>{running ? <><Pause size={14} /> Pause timer</> : <><Play size={14} fill="currentColor" /> Start timer</>}</button>
              <button className="registry-primary" onClick={() => { if (focusTask.id <= 4) toggleTask(focusTask.id); setFocusTask(null); setRunning(false); }}>{focusTask.done ? <><TimerReset size={14} /> Keep open</> : <><Check size={14} /> Finish session</>}</button>
            </div>
            <p className="registry-session-note"><Sparkles size={13} /> Keep this narrow: one concept, one example, one sentence in your own words.</p>
          </section>
        </div>
      )}
    </div>
  );
}

export default RecallRegistry;