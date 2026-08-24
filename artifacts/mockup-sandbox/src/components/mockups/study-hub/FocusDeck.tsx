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
import "./FocusDeck.css";

type Task = {
  id: number;
  title: string;
  course: string;
  kind: string;
  minutes: number;
  accent: string;
  done: boolean;
};

const initialTasks: Task[] = [
  { id: 1, title: "Map the Azure identity model", course: "AZ-104 · Identity & governance", kind: "Deep read", minutes: 24, accent: "coral", done: false },
  { id: 2, title: "Recall: role-based access control", course: "AZ-104 · Identity & governance", kind: "Recall set", minutes: 8, accent: "sage", done: true },
  { id: 3, title: "Explain subnet delegation in one minute", course: "Network troubleshooting", kind: "Teach-back", minutes: 12, accent: "gold", done: false },
  { id: 4, title: "Review the 3 missed concepts", course: "Python fundamentals", kind: "Targeted review", minutes: 16, accent: "blue", done: false },
];

const navItems = [
  { label: "Today", icon: LayoutGrid },
  { label: "Library", icon: BookOpen },
  { label: "Recall", icon: Layers3 },
  { label: "Insights", icon: TrendingUp },
];

export function FocusDeck() {
  const [activeNav, setActiveNav] = useState("Today");
  const [tasks, setTasks] = useState(initialTasks);
  const [query, setQuery] = useState("");
  const [focusTask, setFocusTask] = useState<Task | null>(null);
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

  function toggleTask(id: number) {
    setTasks((current) => current.map((task) => (task.id === id ? { ...task, done: !task.done } : task)));
  }

  function startTask(task: Task) {
    setFocusTask(task);
    setRunning(true);
  }

  return (
    <div className="focus-deck">
      <aside className={`focus-rail ${menuOpen ? "focus-rail--open" : ""}`}>
        <div className="focus-brand">
          <div className="focus-brand-mark"><Sparkles size={17} strokeWidth={2.4} /></div>
          <span>studylab</span>
          <button className="focus-icon focus-close-mobile" onClick={() => setMenuOpen(false)} aria-label="Close navigation"><X size={17} /></button>
        </div>
        <button className="focus-new" onClick={() => startTask({ id: 99, title: "A fresh study sprint", course: "Personal focus", kind: "Open session", minutes: 20, accent: "coral", done: false })}><Plus size={16} /> New session</button>
        <div className="focus-rail-label">Your desk</div>
        <nav className="focus-nav" aria-label="Study desk navigation">
          {navItems.map(({ label, icon: Icon }) => (
            <button className={`focus-nav-item ${activeNav === label ? "is-active" : ""}`} onClick={() => { setActiveNav(label); setMenuOpen(false); }} key={label}>
              <Icon size={17} /><span>{label}</span>{label === "Today" && <span className="focus-nav-count">{tasks.length - completed}</span>}
            </button>
          ))}
        </nav>
        <div className="focus-rail-label focus-rail-label--space">Pinned paths</div>
        <button className="focus-path" onClick={() => setQuery("AZ-104")}>
          <span className="path-swatch path-swatch--coral"></span><span><strong>AZ-104</strong><small>4 chapters open</small></span><ArrowUpRight size={14} />
        </button>
        <button className="focus-path" onClick={() => setQuery("Python")}>
          <span className="path-swatch path-swatch--sage"></span><span><strong>Python fundamentals</strong><small>2 chapters open</small></span><ArrowUpRight size={14} />
        </button>
        <div className="focus-rail-bottom">
          <div className="focus-rail-tip"><Brain size={15} /><div><strong>Small beats heroic.</strong><p>Twenty focused minutes is enough for today.</p></div></div>
          <button className="focus-account"><span className="focus-avatar">AL</span><span><strong>Alex Morgan</strong><small>Personal workspace</small></span><ChevronDown size={15} /></button>
        </div>
      </aside>

      <main className="focus-main">
        <header className="focus-topbar">
          <button className="focus-icon focus-menu-button" onClick={() => setMenuOpen(true)} aria-label="Open navigation"><Menu size={19} /></button>
          <div className="focus-breadcrumb"><span>Tuesday, August 18</span><b>/</b><strong>{activeNav}</strong></div>
          <div className="focus-top-actions">
            <button className="focus-search-button" onClick={() => setShowSearch((value) => !value)}><Search size={16} /><span>Find anything</span><kbd><Command size={10} /> K</kbd></button>
            <button className="focus-icon" aria-label="Notifications"><Circle size={16} /></button>
            <span className="focus-avatar focus-avatar--small">AL</span>
          </div>
        </header>

        <div className="focus-content">
          <section className="focus-intro">
            <div>
              <div className="focus-overline"><span className="focus-live-dot"></span> YOUR STUDY DESK</div>
              <h1>Make a little<br /><em>progress</em> today.</h1>
              <p>One deliberate session is more useful than a perfect plan you never open.</p>
            </div>
            <div className="focus-intro-orbit" aria-hidden="true">
              <div className="orbit-ring orbit-ring--one"></div><div className="orbit-ring orbit-ring--two"></div>
              <div className="orbit-core"><Gauge size={26} /><strong>{Math.round((completed / tasks.length) * 100)}%</strong><span>today</span></div>
              <i className="orbit-dot orbit-dot--one"></i><i className="orbit-dot orbit-dot--two"></i>
            </div>
          </section>

          {showSearch && (
            <div className="focus-search-popover">
              <Search size={16} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your paths and sessions..." /><button className="focus-icon" onClick={() => { setQuery(""); setShowSearch(false); }}><X size={16} /></button>
            </div>
          )}

          <div className="focus-stats">
            <div className="focus-stat focus-stat--warm"><span className="focus-stat-icon"><Flame size={16} /></span><div><strong>4 days</strong><small>current rhythm</small></div><b>+1</b></div>
            <div className="focus-stat focus-stat--cool"><span className="focus-stat-icon"><Clock3 size={16} /></span><div><strong>18 min</strong><small>in the zone this week</small></div><b>steady</b></div>
            <div className="focus-stat focus-stat--quiet"><span className="focus-stat-icon"><Target size={16} /></span><div><strong>{completed} of {tasks.length}</strong><small>today's sessions</small></div><b>{completed === tasks.length ? "done" : "open"}</b></div>
          </div>

          <div className="focus-grid">
            <section className="focus-queue">
              <div className="focus-section-head">
                <div><div className="focus-overline">THE NEXT RIGHT THING</div><h2>Your queue</h2></div>
                <div className="focus-sort"><select value={sortMode} onChange={(event) => setSortMode(event.target.value)} aria-label="Sort sessions"><option>Recommended</option><option>Shortest first</option><option>Unfinished</option></select><ChevronDown size={14} /></div>
              </div>
              <div className="focus-queue-list">
                {visibleTasks.map((task, index) => (
                  <article className={`focus-task ${task.done ? "is-done" : ""}`} key={task.id}>
                    <button className={`task-check task-check--${task.accent}`} onClick={() => toggleTask(task.id)} aria-label={task.done ? `Mark ${task.title} incomplete` : `Mark ${task.title} complete`}>{task.done && <Check size={13} />}</button>
                    <button className="task-copy" onClick={() => startTask(task)}><span className="task-index">0{index + 1}</span><span><strong>{task.title}</strong><small>{task.course}</small></span></button>
                    <span className="task-kind">{task.kind}</span><span className="task-time"><Clock3 size={13} /> {task.minutes}m</span>
                    <button className="task-play" onClick={() => startTask(task)} aria-label={`Start ${task.title}`}><Play size={14} fill="currentColor" /></button>
                  </article>
                ))}
                {visibleTasks.length === 0 && <div className="focus-empty"><Search size={22} /><strong>No sessions match that search.</strong><button onClick={() => { setQuery(""); setSortMode("Recommended"); }}>Clear filters</button></div>}
              </div>
              <button className="focus-add" onClick={() => startTask({ id: 100, title: "A fresh study sprint", course: "Personal focus", kind: "Open session", minutes: 20, accent: "coral", done: false })}><Plus size={15} /> Add a session to the queue</button>
            </section>

            <aside className="focus-side-stack">
              <section className="focus-panel focus-next">
                <div className="focus-overline">PICK UP WHERE YOU LEFT OFF</div>
                <div className="focus-next-art"><div className="focus-next-letter">AZ</div><div className="focus-next-lines"></div><span>62% through</span></div>
                <h3>Azure identity & access</h3><p>Chapter 03 · Service principals</p>
                <div className="focus-progress"><span style={{ width: "62%" }}></span></div>
                <button className="focus-primary" onClick={() => nextTask && startTask(nextTask)}>Continue chapter <ArrowUpRight size={15} /></button>
              </section>
              <section className="focus-panel focus-insight">
                <div className="focus-panel-head"><div className="focus-overline">A NOTE FROM YOUR DATA</div><Sparkles size={16} /></div>
                <h3>Your recall is strongest before lunch.</h3><p>You answer 23% more accurately in the first hour of your study day. Keep the hard concept first.</p>
                <button className="focus-text-button" onClick={() => setActiveNav("Insights")}>Open insights <ArrowUpRight size={14} /></button>
              </section>
            </aside>
          </div>
        </div>
      </main>

      {focusTask && (
        <div className="focus-modal-backdrop" onMouseDown={() => setFocusTask(null)}>
          <section className="focus-session-modal" onMouseDown={(event) => event.stopPropagation()}>
            <button className="focus-modal-close focus-icon" onClick={() => setFocusTask(null)} aria-label="Close focus session"><X size={17} /></button>
            <div className="focus-overline">FOCUS SESSION · {focusTask.kind.toUpperCase()}</div>
            <div className="session-top"><span className={`session-pip session-pip--${focusTask.accent}`}></span><span>{focusTask.course}</span></div>
            <h2>{focusTask.title}</h2>
            <div className="session-timer"><strong>{running ? "18:00" : "00:00"}</strong><span>{running ? "deep work in progress" : "ready when you are"}</span></div>
            <div className="session-actions">
              <button className="focus-secondary" onClick={() => setRunning((value) => !value)}>{running ? <><Pause size={15} /> Pause timer</> : <><Play size={15} fill="currentColor" /> Start timer</>}</button>
              <button className="focus-primary" onClick={() => { toggleTask(focusTask.id); setFocusTask(null); setRunning(false); }}>{focusTask.done ? <><TimerReset size={15} /> Keep open</> : <><Check size={15} /> Finish session</>}</button>
            </div>
            <p className="session-note"><Sparkles size={14} /> Keep this narrow: one concept, one example, one sentence in your own words.</p>
          </section>
        </div>
      )}
    </div>
  );
}

export default FocusDeck;