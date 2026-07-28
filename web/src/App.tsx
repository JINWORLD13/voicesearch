import { useRef, useState } from "react";
import { requestVoice, streamSearch } from "./api";
import type { Source } from "./api";
import Dashboard from "./Dashboard";
import "./App.css";

type Phase = "idle" | "searching" | "answering" | "done";
type VoiceState = "idle" | "loading" | "playing";

// Web Speech API는 크롬 계열에만 있고 공식 타입 정의도 없어서 any로 다룬다
const SpeechRecognitionImpl =
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

const EXAMPLE_QUESTIONS = [
  "요즘 개봉한 영화 중에 뭐가 볼만해?",
  "2026년 최저시급 얼마야?",
  "전기차 보조금 올해 어떻게 바뀌었어?",
];

export default function App() {
  const [view, setView] = useState<"search" | "dashboard">("search");
  const [query, setQuery] = useState("");
  const [listening, setListening] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [sources, setSources] = useState<Source[]>([]);
  const [answer, setAnswer] = useState("");
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceEngine, setVoiceEngine] = useState<"elevenlabs" | "browser" | null>(null);

  // 음성 인식 콜백 안에서 불려도 안전하게, 검색 중복 실행은 ref로 막는다
  const busyRef = useRef(false);
  const recognitionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  async function search(raw: string) {
    const question = raw.trim();
    if (!question || busyRef.current) return;
    busyRef.current = true;

    stopVoice();
    setQuery(question);
    setPhase("searching");
    setSources([]);
    setAnswer("");
    setElapsedMs(null);
    setError(null);

    try {
      await streamSearch(question, (event) => {
        switch (event.type) {
          case "sources":
            setSources(event.sources);
            setPhase("answering");
            break;
          case "delta":
            // 내장 검색 경로는 출처가 답변 뒤에 오므로, 첫 델타가 오면
            // "찾는 중" 표시를 걷고 답변 단계로 넘어간다
            setPhase("answering");
            setAnswer((prev) => prev + event.text);
            break;
          case "done":
            setElapsedMs(event.elapsedMs);
            setPhase("done");
            break;
          case "error":
            setError(event.message);
            setPhase("idle");
            break;
        }
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "요청에 실패했습니다.");
      setPhase("idle");
    } finally {
      busyRef.current = false;
    }
  }

  function toggleListening() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

    const rec = new SpeechRecognitionImpl();
    rec.lang = "ko-KR";
    rec.interimResults = true; // 말하는 중간 결과도 받아서 입력창에 실시간으로 보여준다

    rec.onresult = (event: any) => {
      const transcript = Array.from(event.results)
        .map((r: any) => r[0].transcript)
        .join("");
      setQuery(transcript);
      // 말이 끝났다고 판단되면 버튼을 다시 누를 필요 없이 바로 검색한다
      if (event.results[event.results.length - 1].isFinal) {
        search(transcript);
      }
    };
    rec.onend = () => setListening(false);
    rec.onerror = (event: any) => {
      setListening(false);
      if (event.error === "not-allowed") {
        setError("마이크 권한을 허용해주세요.");
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        setError("음성 인식에 실패했습니다. 다시 시도해주세요.");
      }
    };

    recognitionRef.current = rec;
    setError(null);
    setListening(true);
    rec.start();
  }

  async function toggleVoice() {
    if (voiceState === "playing") {
      stopVoice();
      return;
    }
    setVoiceState("loading");

    const blob = await requestVoice(answer);
    if (blob) {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      // 재생이 끝나든 실패하든(손상된 응답, 자동재생 차단 등) blob URL을 회수하고
      // 버튼 상태를 되돌린다. 안 하면 "정지" 상태로 고착되고 URL이 누수된다.
      const cleanup = () => {
        URL.revokeObjectURL(url);
        setVoiceState("idle");
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      setVoiceEngine("elevenlabs");
      setVoiceState("playing");
      audio.play().catch(cleanup);
    } else {
      // 서버에 ElevenLabs 키가 없거나 호출이 실패한 경우.
      // 데모가 끊기지 않게 브라우저 내장 음성으로 대신 읽는다.
      const utter = new SpeechSynthesisUtterance(answer.replace(/\s*\[\d+\]/g, ""));
      utter.lang = "ko-KR";
      utter.onend = () => setVoiceState("idle");
      setVoiceEngine("browser");
      setVoiceState("playing");
      speechSynthesis.speak(utter);
    }
  }

  function stopVoice() {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      // onended가 안 불린 채 멈추는 경로라, blob URL을 여기서 회수한다(이중 회수는 무해)
      URL.revokeObjectURL(audio.src);
      audioRef.current = null;
    }
    speechSynthesis.cancel();
    setVoiceState("idle");
  }

  return (
    <div className="app">
      <nav className="tabs">
        <span className="brand">VoiceSearch</span>
        <div className="tab-btns">
          <button className={view === "search" ? "active" : ""} onClick={() => setView("search")}>
            검색
          </button>
          <button className={view === "dashboard" ? "active" : ""} onClick={() => setView("dashboard")}>
            대시보드
          </button>
        </div>
      </nav>

      {/* 탭을 바꿔도 폴링/부하 주입 상태가 유지되도록 언마운트 대신 숨김 처리 */}
      <div style={{ display: view === "dashboard" ? "block" : "none" }}>
        <Dashboard />
      </div>

      {view === "search" && (
        <>
          <header className="header">
            <h1>VoiceSearch</h1>
            <p className="tagline">말로 물어보면, 웹을 찾아서 읽어주는 검색</p>
          </header>

      <form
        className="search-box"
        onSubmit={(e) => {
          e.preventDefault();
          search(query);
        }}
      >
        <input
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={listening ? "듣고 있어요, 말씀하세요" : "질문을 입력하거나 마이크를 눌러 말해보세요"}
        />
        {SpeechRecognitionImpl && (
          <button
            type="button"
            className={`mic-btn${listening ? " listening" : ""}`}
            onClick={toggleListening}
            aria-label={listening ? "음성 인식 중지" : "음성으로 검색"}
          >
            <MicIcon />
          </button>
        )}
        <button
          className="submit-btn"
          type="submit"
          disabled={phase === "searching" || phase === "answering"}
        >
          검색
        </button>
      </form>

      {!SpeechRecognitionImpl && (
        <p className="hint">이 브라우저는 음성 인식이 안 돼요. 크롬에서 열면 마이크로 검색할 수 있어요.</p>
      )}

      {error && <div className="error-banner">{error}</div>}

      {phase === "idle" && (
        <div className="examples">
          {EXAMPLE_QUESTIONS.map((q) => (
            <button key={q} className="example-chip" onClick={() => search(q)}>
              {q}
            </button>
          ))}
        </div>
      )}

      {phase === "searching" && <p className="status">웹에서 찾는 중</p>}

      {sources.length > 0 && (
        <section className="sources">
          <h2>출처</h2>
          <ul>
            {sources.map((s) => {
              // 내장 검색 경로는 제목이 곧 도메인이라, 같은 값을 두 줄로
              // 반복하지 않게 메타 줄에서 뺀다
              const meta = [s.domain !== s.title ? s.domain : null, s.publishedDate]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={s.index}>
                  <a href={s.url} target="_blank" rel="noreferrer" className="source-card">
                    <span className="source-index">{s.index}</span>
                    <span className="source-body">
                      <span className="source-title">{s.title}</span>
                      {meta && <span className="source-meta">{meta}</span>}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {(answer || phase === "answering") && (
        <section className="answer">
          <p className="answer-text">
            {answer}
            {phase === "answering" && <span className="cursor" />}
          </p>
          {phase === "done" && (
            <div className="answer-footer">
              <button
                className="voice-btn"
                onClick={toggleVoice}
                disabled={voiceState === "loading"}
              >
                {voiceState === "idle" && "읽어주기"}
                {voiceState === "loading" && "음성 만드는 중"}
                {voiceState === "playing" && "정지"}
              </button>
              {voiceState === "playing" && voiceEngine === "browser" && (
                <span className="voice-note">브라우저 내장 음성으로 읽는 중</span>
              )}
              {elapsedMs !== null && <span className="elapsed">{(elapsedMs / 1000).toFixed(1)}초</span>}
            </div>
          )}
        </section>
      )}
        </>
      )}
    </div>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 1 0-7 0v6A3.5 3.5 0 0 0 12 15z" />
      <path d="M18.5 11.5a6.5 6.5 0 0 1-13 0H4a8 8 0 0 0 7 7.94V22h2v-2.56a8 8 0 0 0 7-7.94h-1.5z" />
    </svg>
  );
}
