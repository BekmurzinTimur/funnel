// Track B — SPEC §4, §6, §11: the funnel renderer.
// The server decides navigation; this page renders whatever it returns. No optimistic
// advance, and no knowledge of variants — `session.config` is already materialised.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NavigationResponse, SessionResponse } from '@shared/api';
import { validate } from '@shared/navigation';
import type { AnswerValue, Answers } from '@shared/types';
import { HttpError } from '../lib/http';
import { createSession, currentSearch, postAnswer, postBack, removeResetParam, startOverSearch } from './api';
import { emitBack, emitCta, emitForward, emitStepViewed, eventContext } from './events';
import type { StepError } from './parts';
import ProgressBar from './ProgressBar';
import StepView from './StepView';
import './funnel.css';

interface Loaded {
  /** sessionId and the pinned, materialised config. */
  session: SessionResponse;
  /** Mirror of stored answers, used only to prefill drafts (Back / refresh / re-entered branch). */
  answers: Answers;
  nav: NavigationResponse;
  /** Changes whenever a different step is rendered; keys the step so its draft re-initialises. */
  view: number;
}

type Status = 'loading' | 'error' | 'ready';

const navOf = (s: SessionResponse): NavigationResponse => ({
  currentStepId: s.currentStepId,
  visibleSteps: s.visibleSteps,
  progress: s.progress,
  resultId: s.resultId,
});

function serverMessage(e: HttpError): string | null {
  const body = e.body as { message?: unknown } | null;
  return body && typeof body === 'object' && typeof body.message === 'string' ? body.message : null;
}

export default function FunnelPage() {
  const [status, setStatus] = useState<Status>('loading');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StepError | null>(null);

  const busyRef = useRef(false); // synchronous guard against double submits
  const loadSeq = useRef(0); // invalidates responses that belong to a superseded session load
  const lastSearch = useRef('');
  const views = useRef(0);
  const initialised = useRef(false);

  /** POST /api/session (create / resume / reset) and render the returned step. */
  const load = useCallback(async (search: string) => {
    const seq = ++loadSeq.current;
    lastSearch.current = search;
    setStatus('loading');
    setError(null);
    try {
      const session = await createSession(search);
      if (seq !== loadSeq.current) return;
      removeResetParam();
      const nav = navOf(session);
      setLoaded({ session, answers: session.answers ?? {}, nav, view: ++views.current });
      setStatus('ready');
      emitStepViewed(eventContext(session), session.config, nav);
    } catch {
      if (seq === loadSeq.current) setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;
    void load(window.location.search);
  }, [load]);

  const title = loaded?.session.config.title;
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  /** Render a navigation response; step_viewed fires only when a different step is now on screen. */
  const apply = (from: Loaded, nav: NavigationResponse, patch?: Answers) => {
    const changed = nav.currentStepId !== from.nav.currentStepId;
    setLoaded({
      ...from,
      answers: patch ? { ...from.answers, ...patch } : from.answers,
      nav,
      view: changed ? ++views.current : from.view,
    });
    if (changed) emitStepViewed(eventContext(from.session), from.session.config, nav);
  };

  const fail = (e: unknown, retry: () => void) => {
    if (e instanceof HttpError && e.status === 404) {
      // session_not_found (expired or cleared): start again with a fresh create/resume.
      void load(currentSearch());
    } else if (e instanceof HttpError && e.status === 400) {
      setError({ message: serverMessage(e) ?? "That answer wasn't accepted. Please check it and try again." });
    } else {
      setError({ message: "We couldn't save your progress. Check your connection and try again.", retry });
    }
  };

  /** Shared wrapper for /answer and /back: in-flight guard, stale-load guard, error mapping. */
  const navigate = async (run: (from: Loaded, stepId: string) => Promise<void>, retry: () => void) => {
    const from = loaded;
    const stepId = from?.nav.currentStepId;
    if (!from || !stepId || busyRef.current) return;
    const seq = loadSeq.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await run(from, stepId);
    } catch (e) {
      if (seq === loadSeq.current) fail(e, retry);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const submit = (value?: AnswerValue) => {
    if (!loaded?.nav.currentStepId || busyRef.current) return;
    const step = loaded.session.config.steps[loaded.nav.currentStepId];
    if (step) {
      const check = validate(step, value); // instant feedback; the server re-validates
      if (!check.ok) {
        setError({ message: check.message });
        return;
      }
    }
    void navigate(async (from, stepId) => {
      const seq = loadSeq.current;
      const nav = await postAnswer(stepId, value);
      if (seq !== loadSeq.current) return;
      const moved = nav.currentStepId !== stepId;
      if (moved) emitForward(eventContext(from.session), step, stepId, nav);
      apply(from, nav, moved && value !== undefined ? { [stepId]: value } : undefined);
    }, () => submit(value));
  };

  const back = () => {
    void navigate(async (from, stepId) => {
      const seq = loadSeq.current;
      const nav = await postBack(stepId);
      if (seq !== loadSeq.current) return;
      if (nav.currentStepId !== stepId) emitBack(eventContext(from.session), stepId, nav);
      apply(from, nav);
    }, back);
  };

  const startOver = () => {
    if (busyRef.current) return;
    void load(startOverSearch());
  };

  const cta = (action: string, expanding: boolean) => {
    if (loaded) emitCta(eventContext(loaded.session), loaded.nav.currentStepId, action, expanding);
  };

  const config = loaded?.session.config;
  const stepId = loaded?.nav.currentStepId ?? null;
  const isFirst = !!loaded && loaded.nav.visibleSteps[0] === stepId;

  return (
    <main className="page fn-page">
      <header className="fn-header">
        <span className="fn-brand">{config?.title ?? ''}</span>
        <button type="button" className="fn-start-over" onClick={startOver} disabled={busy || status === 'loading'}>
          Start over
        </button>
      </header>

      {status === 'loading' && (
        <div className="card fn-card fn-status" role="status" aria-live="polite">
          <div className="fn-loading">
            <span className="fn-spinner" aria-hidden="true" />
            <span>Loading…</span>
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="card fn-card fn-status" role="alert">
          <div className="fn-heading">
            <h1 className="fn-title">We couldn't load the questions</h1>
            <p className="fn-text">Check your connection and try again.</p>
          </div>
          <button type="button" className="primary fn-primary" onClick={() => void load(lastSearch.current)}>
            Try again
          </button>
        </div>
      )}

      {status === 'ready' && loaded && config && (
        <>
          <ProgressBar progress={loaded.nav.progress} complete={!!stepId && config.steps[stepId]?.type === 'result'} />
          <section className="card fn-card" key={`${loaded.session.sessionId}:${loaded.view}`} aria-busy={busy}>
            <StepView
              config={config}
              stepId={stepId}
              answers={loaded.answers}
              resultId={loaded.nav.resultId}
              busy={busy}
              error={error}
              onBack={isFirst ? null : back}
              onSubmit={submit}
              onEdit={() => setError(null)}
              onCta={cta}
              onReload={() => void load(currentSearch())}
              onStartOver={startOver}
            />
          </section>
        </>
      )}
    </main>
  );
}
