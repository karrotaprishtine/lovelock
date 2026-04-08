import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

import {
  ANSWER_CHARACTER_LIMIT,
  MESSAGE_CHARACTER_LIMIT,
  MESSAGE_UNLOCK_WINS,
  SERVER_EVENTS,
  countCharacters
} from "@shared/constants";
import { buttonMessages, leaveMessages, waitingMessages } from "@shared/content";

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ??
  (window.location.port === "5173"
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : window.location.origin);
const prefilledCode = new URLSearchParams(window.location.search).get("code") ?? "";
const HEART = "\u2764";
const SPARK = "\u2726";
const CROSS = "\u00D7";

const doodles = [
  { id: "heart-1", type: "heart", top: "9%", left: "8%", delay: "0s", size: "1.8rem" },
  { id: "heart-2", type: "heart", top: "16%", left: "85%", delay: "2s", size: "1.2rem" },
  { id: "heart-3", type: "heart", top: "78%", left: "10%", delay: "4s", size: "1.4rem" },
  { id: "heart-4", type: "heart", top: "84%", left: "78%", delay: "1s", size: "1rem" },
  { id: "line-1", type: "line", top: "18%", left: "24%", delay: "0.5s", width: "6rem", rotation: "-16deg" },
  { id: "line-2", type: "line", top: "68%", left: "82%", delay: "3.2s", width: "4.5rem", rotation: "22deg" },
  { id: "line-3", type: "line", top: "76%", left: "28%", delay: "1.8s", width: "5rem", rotation: "-8deg" },
  { id: "spark-1", type: "spark", top: "32%", left: "74%", delay: "1.3s", size: "1.6rem" },
  { id: "spark-2", type: "spark", top: "58%", left: "18%", delay: "2.5s", size: "1.4rem" }
];

const waitingTapPositions = [
  { left: 12, top: 8, rotate: -12 },
  { left: 78, top: 10, rotate: 8 },
  { left: 23, top: 27, rotate: -6 },
  { left: 84, top: 31, rotate: 10 },
  { left: 9, top: 46, rotate: -10 },
  { left: 71, top: 47, rotate: 9 },
  { left: 34, top: 63, rotate: -5 },
  { left: 88, top: 68, rotate: 7 },
  { left: 18, top: 83, rotate: -9 },
  { left: 62, top: 86, rotate: 6 }
];

const leaveTeaseMessages = [
  "nice try.",
  "too dramatic.",
  "one more move.",
  "the board said no.",
  "caught you.",
  "suspicious exit.",
  "stay a second.",
  "almost escaped."
];

function pickNextTapPosition(currentIndex) {
  const currentPosition = waitingTapPositions[currentIndex] ?? waitingTapPositions[0];
  const fallback = waitingTapPositions
    .map((position, index) => ({ ...position, index }))
    .filter((position) => position.index !== currentIndex);
  const distantOptions = fallback.filter((position) => {
    const dx = position.left - currentPosition.left;
    const dy = position.top - currentPosition.top;

    return Math.hypot(dx, dy) >= 24;
  });
  const pool = distantOptions.length > 0 ? distantOptions : fallback;

  return randomFrom(pool).index;
}

function randomFrom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function pickNextLeaveTease(previousMessage = "") {
  const pool = [...leaveTeaseMessages, ...leaveMessages]
    .map((message) => String(message).trim())
    .filter((message) => message && message !== previousMessage);

  return randomFrom(pool.length > 0 ? pool : leaveTeaseMessages);
}

function getShareLink(code) {
  return code ? `${window.location.origin}?code=${code}` : null;
}

function normalizeInviteEntry(value = "") {
  const raw = String(value).trim();

  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    return (url.searchParams.get("code") ?? raw).trim().toUpperCase();
  } catch {
    const match = raw.match(/[?&]code=([A-Za-z0-9_-]+)/i);
    return (match?.[1] ?? raw).trim().toUpperCase();
  }
}

function createWaitingFrame() {
  const message = randomFrom(waitingMessages);
  let quote = randomFrom(waitingMessages);

  if (quote === message) {
    quote = randomFrom(waitingMessages);
  }

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    message,
    accent: randomFrom(buttonMessages),
    quote
  };
}

function App() {
  const socketRef = useRef(null);
  const authTokenRef = useRef(window.localStorage.getItem("lovelock-auth") ?? "");
  const [appState, setAppState] = useState({ mode: "entry", self: null });
  const [socketState, setSocketState] = useState("connecting");
  const [toasts, setToasts] = useState([]);
  const [entryForm, setEntryForm] = useState({
    name: "",
    gender: "",
    inviteCode: prefilledCode
  });
  const [inviteCodeInput, setInviteCodeInput] = useState(prefilledCode);
  const [answerInput, setAnswerInput] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [waitingFrame, setWaitingFrame] = useState(createWaitingFrame);
  const [leaveOffset, setLeaveOffset] = useState({ x: 0, y: 0 });
  const [leaveChallenge, setLeaveChallenge] = useState({ attempts: 0, message: "" });

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
      autoConnect: true,
      reconnection: true
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setSocketState("connected");

      if (authTokenRef.current) {
        socket.emit(SERVER_EVENTS.RESUME_PLAYER, {
          authToken: authTokenRef.current
        });
      }
    });

    socket.on("disconnect", () => {
      setSocketState("disconnected");
    });

    socket.io.on("reconnect_attempt", () => {
      setSocketState("reconnecting");
    });

    socket.io.on("reconnect", () => {
      setSocketState("connected");
    });

    socket.on(SERVER_EVENTS.STATE_UPDATE, (nextState) => {
      setAppState(nextState);

      if (nextState?.self?.authToken) {
        authTokenRef.current = nextState.self.authToken;
        window.localStorage.setItem("lovelock-auth", nextState.self.authToken);
      }
    });

    socket.on(SERVER_EVENTS.TOAST, (toast) => {
      setToasts((current) => [...current, toast].slice(-4));
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (toasts.length === 0) {
      return undefined;
    }

    const timeout = setTimeout(() => {
      setToasts((current) => current.slice(1));
    }, 2800);

    return () => clearTimeout(timeout);
  }, [toasts]);

  useEffect(() => {
    if (appState.mode === "waiting") {
      cycleWaitingFrame();
    }
  }, [appState.mode]);

  useEffect(() => {
    if (appState.session?.phase !== "answering") {
      setAnswerInput("");
      if (answerInput) {
        emit(SERVER_EVENTS.ANSWER_TYPING, { isTyping: false });
      }
    }
  }, [answerInput, appState.session?.phase, appState.session?.selectedQuestion?.id]);

  useEffect(() => {
    if (appState.mode !== "game" || appState.session?.phase !== "draw") {
      return undefined;
    }

    const timeout = setTimeout(() => {
      if (socketRef.current?.connected) {
        socketRef.current.emit(SERVER_EVENTS.REQUEST_REMATCH);
      }
    }, 3000);

    return () => clearTimeout(timeout);
  }, [appState.mode, appState.session?.phase, appState.session?.id, appState.session?.round]);

  useEffect(() => {
    setLeaveOffset({ x: 0, y: 0 });
    setLeaveChallenge({ attempts: 0, message: "" });
  }, [appState.mode, appState.session?.id]);

  const session = appState.session;
  const selfId = appState.self?.id;
  const isWinner = session?.pendingWinnerPlayerId === selfId;
  const isLoser = session?.pendingLoserPlayerId === selfId;
  const activeMessageRule = session?.message ?? {
    unlocked: false,
    winCount: 0,
    winsRemaining: MESSAGE_UNLOCK_WINS,
    unlockWins: MESSAGE_UNLOCK_WINS,
    maxCharacters: MESSAGE_CHARACTER_LIMIT,
    available: 0,
    messages: []
  };

  function cycleWaitingFrame() {
    setWaitingFrame(createWaitingFrame());
  }

  function pushToast(message, tone = "info") {
    setToasts((current) => [
      ...current,
      { id: String(Date.now()) + Math.random(), tone, message }
    ].slice(-4));
  }

  function emit(event, payload = {}) {
    if (!socketRef.current?.connected) {
      pushToast("Reconnecting to Lovelock...", "warning");
      return;
    }

    socketRef.current.emit(event, payload);
  }

  function handleEntrySubmit(event) {
    event.preventDefault();
    const normalizedInviteCode = normalizeInviteEntry(entryForm.inviteCode);

    if (!entryForm.name.trim()) {
      pushToast("Add your name before the heart hunt begins.", "warning");
      return;
    }

    if (!entryForm.gender) {
      pushToast("Pick woman or man first.", "warning");
      return;
    }

    emit(SERVER_EVENTS.ENTER_LOVELOCK, {
      name: entryForm.name.trim(),
      gender: entryForm.gender,
      inviteCode: normalizedInviteCode,
      authToken: authTokenRef.current || undefined
    });
  }

  function handleGenerateInvite() {
    emit(SERVER_EVENTS.GENERATE_INVITE);
  }

  async function handleShareLink() {
    const shareLink = getShareLink(appState.invite?.code ?? session?.inviteCode);

    if (!shareLink) {
      pushToast("Make a code first.", "warning");
      return;
    }

    try {
      await navigator.clipboard.writeText(shareLink);
      pushToast("Link copied.", "success");
    } catch {
      pushToast("Could not copy the link automatically.", "warning");
    }
  }

  function handleJoinByCode(value = inviteCodeInput) {
    const normalizedInviteCode = normalizeInviteEntry(value);

    if (!normalizedInviteCode) {
      pushToast("Enter a code first.", "warning");
      return;
    }

    if (!appState.self) {
      setEntryForm((current) => ({ ...current, inviteCode: normalizedInviteCode }));
      pushToast("Press play to use that code.", "info");
      return;
    }

    emit(SERVER_EVENTS.JOIN_INVITE, {
      code: normalizedInviteCode
    });
  }

  function handleBoardMove(index) {
    emit(SERVER_EVENTS.MAKE_MOVE, { cellIndex: index });
  }

  function handleQuestionSelect(questionId) {
    emit(SERVER_EVENTS.SELECT_QUESTION, { questionId });
  }

  function handleAnswerSubmit(event) {
    event.preventDefault();
    const characters = countCharacters(answerInput);

    if (!answerInput.trim() || characters > ANSWER_CHARACTER_LIMIT) {
      pushToast(`Answers stay within ${ANSWER_CHARACTER_LIMIT}.`, "warning");
      return;
    }

    emit(SERVER_EVENTS.SUBMIT_ANSWER, { answer: answerInput.trim() });
  }

  function handleAnswerInputChange(value) {
    const nextValue = value.slice(0, ANSWER_CHARACTER_LIMIT);

    setAnswerInput(nextValue);
    emit(SERVER_EVENTS.ANSWER_TYPING, {
      isTyping: nextValue.trim().length > 0
    });
  }

  function handleChatSubmit(event) {
    event.preventDefault();
    const characters = countCharacters(chatInput);

    if (activeMessageRule.available < 1) {
      pushToast(`Win ${activeMessageRule.winsRemaining} more to earn one message.`, "warning");
      return;
    }

    if (!chatInput.trim() || characters > activeMessageRule.maxCharacters) {
      pushToast(`Message stays within ${activeMessageRule.maxCharacters}.`, "warning");
      return;
    }

    emit(SERVER_EVENTS.SEND_CHAT, { message: chatInput.trim() });
    setChatInput("");
  }

  function nudgeLeaveButton(intensity = "soft") {
    const spreadX = intensity === "big" ? 112 : 56;
    const spreadY = intensity === "big" ? 42 : 20;

    setLeaveOffset({
      x: Math.floor(Math.random() * spreadX) - Math.floor(spreadX / 2),
      y: Math.floor(Math.random() * spreadY) - Math.floor(spreadY / 2)
    });
  }

  function handleLeaveAttempt() {
    if (leaveChallenge.attempts >= 2) {
      setLeaveChallenge({ attempts: 0, message: "" });
      setLeaveOffset({ x: 0, y: 0 });
      emit(SERVER_EVENTS.LEAVE_FLOW);
      return;
    }

    setLeaveChallenge((current) => ({
      attempts: current.attempts + 1,
      message: pickNextLeaveTease(current.message)
    }));
    nudgeLeaveButton("big");
  }

  return (
    <div className="app-shell">
      <Backdrop />
      <CursorAura />
      <ReconnectBanner status={socketState} connectionWarning={session?.connectionWarning} />

      <main className="app-frame">
        {appState.mode === "entry" && (
          <EntryScreen
            entryForm={entryForm}
            inviteCodeInput={inviteCodeInput}
            onChange={setEntryForm}
            onInviteCodeChange={setInviteCodeInput}
            onSubmit={handleEntrySubmit}
          />
        )}

        {appState.mode === "waiting" && (
          <WaitingScreen
            player={appState.self}
            waiting={waitingFrame}
            invite={appState.invite}
            inviteCodeInput={inviteCodeInput}
            onInviteCodeChange={setInviteCodeInput}
            onGenerateInvite={handleGenerateInvite}
            onShareLink={handleShareLink}
            onJoinByCode={handleJoinByCode}
            onShuffleWaiting={cycleWaitingFrame}
            leaveOffset={leaveOffset}
            leaveTease={leaveChallenge.message}
            onLeaveHover={() => nudgeLeaveButton()}
            onLeaveAttempt={handleLeaveAttempt}
          />
        )}

        {appState.mode === "game" && session && (
          <GameScreen
            session={session}
            selfId={selfId}
            chatInput={chatInput}
            answerInput={answerInput}
            onMove={handleBoardMove}
            onChatInput={setChatInput}
            onChatSubmit={handleChatSubmit}
            onAnswerInput={handleAnswerInputChange}
            onAnswerSubmit={handleAnswerSubmit}
            onQuestionSelect={handleQuestionSelect}
            leaveOffset={leaveOffset}
            leaveTease={leaveChallenge.message}
            onLeaveHover={() => nudgeLeaveButton()}
            onLeaveAttempt={handleLeaveAttempt}
            isWinner={isWinner}
            isLoser={isLoser}
          />
        )}
      </main>

      <ToastRack toasts={toasts} />
    </div>
  );
}

function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      <div className="backdrop__wash" />
      <div className="backdrop__glow backdrop__glow--one" />
      <div className="backdrop__glow backdrop__glow--two" />
      {doodles.map((doodle) => (
        <span
          key={doodle.id}
          className={`doodle doodle--${doodle.type}`}
          style={{
            top: doodle.top,
            left: doodle.left,
            animationDelay: doodle.delay,
            fontSize: doodle.size,
            width: doodle.width,
            "--doodle-rotate": doodle.rotation ?? "0deg"
          }}
        >
          {doodle.type === "heart" ? HEART : doodle.type === "spark" ? SPARK : ""}
        </span>
      ))}
    </div>
  );
}

function ReconnectBanner({ status, connectionWarning }) {
  if (status === "connected" && !connectionWarning) {
    return null;
  }

  return (
    <div className="reconnect-banner">
      <span className="status-dot" />
      {connectionWarning ?? (status === "reconnecting" ? "Trying to reconnect..." : "Connection is floating. Hold tight.")}
    </div>
  );
}

function EntryScreen({ entryForm, inviteCodeInput, onChange, onInviteCodeChange, onSubmit }) {
  const [showCodeField, setShowCodeField] = useState(Boolean(entryForm.inviteCode));

  return (
    <section className="screen screen--entry">
      <div className="entry-layout entry-layout--minimal">
        <form className="entry-minimal" onSubmit={onSubmit}>
          <p className="eyebrow">Play. Win. Unlock.</p>
          <h1>Lovelock</h1>
          <p className="lede">name. gender. play.</p>

          <label className="paper-field paper-field--entry">
            <span>Name</span>
            <input
              type="text"
              maxLength={24}
              value={entryForm.name}
              placeholder="enter your name"
              onChange={(event) => onChange((current) => ({ ...current, name: event.target.value }))}
            />
          </label>

          <div className="paper-choice paper-choice--entry">
            <span className="field-label">Gender</span>
            <div className="ink-switch-row">
              {[
                { value: "female", title: "Woman" },
                { value: "male", title: "Man" }
              ].map((option) => (
                <button
                  key={option.value}
                  className={`ink-switch ${entryForm.gender === option.value ? "ink-switch--active" : ""}`}
                  type="button"
                  onClick={() => onChange((current) => ({ ...current, gender: option.value }))}
                >
                  <span>{option.title}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="scribble-actions scribble-actions--entry">
            <button className="primary-button scribble-action" type="submit">
              play
            </button>
            <button
              type="button"
              className="ghost-button scribble-link"
              onClick={() => setShowCodeField((current) => !current)}
            >
              {showCodeField ? "hide code" : "use code"}
            </button>
          </div>

          {showCodeField && (
            <div className="entry-options">
              <label className="paper-field paper-field--compact">
                <span>Code</span>
                <input
                  type="text"
                  value={entryForm.inviteCode}
                  placeholder="optional"
                  onChange={(event) => {
                    onChange((current) => ({ ...current, inviteCode: event.target.value }));
                    onInviteCodeChange(event.target.value);
                  }}
                />
              </label>

              <button
                type="button"
                className="ghost-button scribble-link scribble-link--soft"
                onClick={() => onChange((current) => ({ ...current, inviteCode: inviteCodeInput }))}
              >
                use pasted link/code
              </button>
            </div>
          )}
        </form>
      </div>
    </section>
  );
}

function WaitingScreen({
  player,
  waiting,
  invite,
  inviteCodeInput,
  onInviteCodeChange,
  onGenerateInvite,
  onShareLink,
  onJoinByCode,
  onShuffleWaiting,
  leaveOffset,
  leaveTease,
  onLeaveHover,
  onLeaveAttempt
}) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const requestedInviteRef = useRef(false);

  useEffect(() => {
    if (!inviteOpen) {
      requestedInviteRef.current = false;
      return;
    }

    if (!invite?.code && !requestedInviteRef.current) {
      requestedInviteRef.current = true;
      onGenerateInvite();
    }
  }, [inviteOpen, invite?.code, onGenerateInvite]);

  return (
    <section className="screen screen--waiting">
      <div className="waiting-paper-layout waiting-paper-layout--single">
        <article className="waiting-sheet waiting-sheet--minimal">
          <p className="eyebrow">finding someone</p>
          <h2 key={`waiting-message-${waiting.id}`} className="waiting-copy-swap">
            {waiting.message}
          </h2>
          <p key={`waiting-quote-${waiting.id}`} className="lede lede--tight waiting-copy-swap">
            {waiting.quote}
          </p>

          <div className="ink-loader" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>

          <WaitingPlayground waiting={waiting} onShuffleWaiting={onShuffleWaiting} />

          <div className="quiet-status">
            <p key={`waiting-accent-${waiting.id}`} className="waiting-copy-swap waiting-copy-swap--accent">
              {waiting.accent}
            </p>
          </div>

          <div className="scribble-actions scribble-actions--waiting">
            <button
              type="button"
              className="ghost-button scribble-link"
              onClick={() => setInviteOpen(true)}
            >
              play with someone
            </button>
          </div>

          <button
            className="secondary-button scribble-link scribble-link--shy leave-dodge"
            type="button"
            onMouseEnter={onLeaveHover}
            onClick={onLeaveAttempt}
            style={{ "--leave-x": `${leaveOffset.x}px`, "--leave-y": `${leaveOffset.y}px` }}
          >
            leave anyway
          </button>
          {leaveTease && <p className="leave-tease">{leaveTease}</p>}
        </article>

        {inviteOpen && (
          <InviteModal
            invite={invite}
            inviteCodeInput={inviteCodeInput}
            onShareLink={onShareLink}
            onJoinByCode={onJoinByCode}
            onClose={() => setInviteOpen(false)}
          />
        )}
      </div>
    </section>
  );
}

function WaitingPlayground({ waiting, onShuffleWaiting }) {
  const [burstKey, setBurstKey] = useState(0);
  const [positionIndex, setPositionIndex] = useState(() => Math.floor(Math.random() * waitingTapPositions.length));
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (!isAnimating) {
      return undefined;
    }

    const timeout = setTimeout(() => {
      setIsAnimating(false);
    }, 420);

    return () => clearTimeout(timeout);
  }, [isAnimating]);

  function handleShuffle() {
    setBurstKey((current) => current + 1);
    setIsAnimating(true);
    setPositionIndex((current) => pickNextTapPosition(current));
    onShuffleWaiting();
  }

  const tapPosition = waitingTapPositions[positionIndex];

  return (
    <div className="waiting-playground">
      <div className="waiting-playground__board" aria-hidden="true">
        <span className="waiting-playground__line waiting-playground__line--v-one" />
        <span className="waiting-playground__line waiting-playground__line--v-two" />
        <span className="waiting-playground__line waiting-playground__line--h-one" />
        <span className="waiting-playground__line waiting-playground__line--h-two" />
        <span className="waiting-playground__mark waiting-playground__mark--x waiting-playground__mark--one">{CROSS}</span>
        <span className="waiting-playground__mark waiting-playground__mark--heart waiting-playground__mark--two">{HEART}</span>
        <span className="waiting-playground__mark waiting-playground__mark--heart waiting-playground__mark--three">{HEART}</span>
      </div>

      <div className="waiting-playground__copy">
        <p key={`waiting-playground-${waiting.id}`} className="waiting-copy-swap waiting-copy-swap--playground">
          {waiting.quote || "Someone good is getting closer."}
        </p>
      </div>

      <button
        type="button"
        className={`waiting-playground__stamp ${isAnimating ? "waiting-playground__stamp--burst" : ""}`}
        onClick={handleShuffle}
        style={{
          left: `${tapPosition.left}%`,
          top: `${tapPosition.top}%`,
          transform: `translate(-50%, -50%) rotate(${tapPosition.rotate}deg)`,
          "--tap-rotate": `${tapPosition.rotate}deg`
        }}
      >
        tap
        <span key={`heart-${burstKey}`} className="waiting-playground__stamp-heart">
          {HEART}
        </span>
        <span key={`burst-${burstKey}`} className="waiting-playground__burst" aria-hidden="true">
          {HEART}
        </span>
      </button>
    </div>
  );
}

function InviteModal({
  invite,
  inviteCodeInput,
  onShareLink,
  onJoinByCode,
  onClose
}) {
  const [joinInput, setJoinInput] = useState(inviteCodeInput);
  const shareLink = getShareLink(invite?.code);

  useEffect(() => {
    setJoinInput(inviteCodeInput);
  }, [inviteCodeInput]);

  return (
    <div className="modal-layer">
      <div className="modal-card invite-modal">
        <h3>play with someone</h3>
        <p className="modal-subtitle">your code is ready. send the link or paste one to join.</p>

        <div className="invite-modal__stack">
          <div className="paper-code-card">
            <span>code</span>
            <strong>{invite?.code ?? "making..."}</strong>
          </div>

          <label className="paper-field">
            <span>link</span>
            <input type="text" value={shareLink ?? ""} readOnly placeholder="making your link..." />
          </label>

          <label className="paper-field">
            <span>paste link or code</span>
            <input
              type="text"
              value={joinInput}
              placeholder="paste here"
              onChange={(event) => setJoinInput(event.target.value)}
            />
          </label>
        </div>

        <div className="scribble-actions">
          <button className="primary-button scribble-action" type="button" onClick={onShareLink}>
            copy
          </button>
          <button className="ghost-button scribble-link" type="button" onClick={() => onJoinByCode(joinInput)}>
            join
          </button>
          <button className="ghost-button scribble-link scribble-link--soft" type="button" onClick={onClose}>
            close
          </button>
        </div>
      </div>
    </div>
  );
}

function getVisibleMessages(messages, currentTime) {
  return messages.filter((message) => {
    const createdAt = Date.parse(message.createdAt ?? "");

    if (!Number.isFinite(createdAt)) {
      return true;
    }

    return currentTime - createdAt < 10_000;
  });
}

function getVisibleInteractions(interactions, currentTime) {
  return interactions.filter((interaction) => {
    if (!interaction.questionText || !interaction.answerText) {
      return false;
    }

    const createdAt = Date.parse(interaction.createdAt ?? "");

    if (!Number.isFinite(createdAt)) {
      return true;
    }

    return currentTime - createdAt < 10_000;
  });
}

function LiveInteractionLayer({ interactions }) {
  if (interactions.length === 0) {
    return null;
  }

  return (
    <div className="live-interaction-layer" aria-live="polite">
      {interactions.slice(0, 1).map((interaction) => (
        <article key={interaction.id} className="live-interaction-card">
          <span>just unlocked</span>
          <strong>{interaction.questionText}</strong>
          <p>{interaction.answerText}</p>
        </article>
      ))}
    </div>
  );
}

function LiveMessageLayer({ messages, selfId }) {
  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="live-message-layer" aria-live="polite">
      {messages.slice(-3).map((message) => (
        <article
          key={message.id}
          className={`live-message-bubble ${message.playerId === selfId ? "live-message-bubble--self" : ""}`}
        >
          <span>{message.playerId === selfId ? "you" : message.authorName}</span>
          <p>{message.content}</p>
        </article>
      ))}
    </div>
  );
}

function BubbleComposer({ maxCharacters, value, onChange, onSubmit }) {
  return (
    <form className="bubble-composer" onSubmit={onSubmit}>
      <label className="bubble-composer__field">
        <span>one message</span>
        <textarea
          value={value}
          maxLength={maxCharacters}
          placeholder="say it once"
          onChange={(event) => onChange(event.target.value.slice(0, maxCharacters))}
        />
      </label>
      <div className="bubble-composer__footer">
        <span>{countCharacters(value)} / {maxCharacters}</span>
        <button className="ghost-button scribble-link" type="submit">
          send
        </button>
      </div>
    </form>
  );
}

function GameScreen({
  session,
  selfId,
  chatInput,
  answerInput,
  onMove,
  onChatInput,
  onChatSubmit,
  onAnswerInput,
  onAnswerSubmit,
  onQuestionSelect,
  leaveOffset,
  leaveTease,
  onLeaveHover,
  onLeaveAttempt,
  isWinner,
  isLoser
}) {
  const [detailPanel, setDetailPanel] = useState(null);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const self = session.players.find((player) => player.id === selfId);
  const opponent = session.players.find((player) => player.id !== selfId);
  const isYourTurn = session.currentTurnPlayerId === selfId && session.phase === "playing";
  const messageState = session.message;
  const visibleInteractions = getVisibleInteractions(session.interactionHistory, currentTime);
  const visibleMessages = getVisibleMessages(messageState.messages, currentTime);
  const turnLabel = isYourTurn ? "your turn" : "their turn";
  const winnerSymbol = session.players.find((player) => player.id === session.pendingWinnerPlayerId)?.symbol ?? null;
  const hasAnswers = session.interactionHistory.some((item) => item.questionText || item.answerText);
  const winnerPlayer = session.players.find((player) => player.id === session.pendingWinnerPlayerId) ?? null;
  const loserPlayer = session.players.find((player) => player.id === session.pendingLoserPlayerId) ?? null;
  const pickerName = winnerPlayer?.id === selfId ? "you" : winnerPlayer?.name ?? "they";
  const responderName = loserPlayer?.id === selfId ? "you" : loserPlayer?.name ?? "they";
  const answerStatus =
    session.answerTypingPlayerId === session.pendingLoserPlayerId ? "typing..." : "thinking...";
  const boardTitle =
    session.phase === "question-pick"
      ? pickerName
      : session.phase === "answering"
        ? responderName
        : session.phase === "draw"
          ? "draw"
          : turnLabel;
  const boardCaption =
    session.phase === "question-pick"
      ? isWinner
        ? "pick one"
        : "picking..."
      : session.phase === "answering"
        ? isLoser
          ? "25 max"
          : answerStatus
        : session.phase === "draw"
          ? "next round in 3"
          : turnLabel;
  const messageLabel = messageState.unlocked
    ? `${messageState.available} ${messageState.available === 1 ? "message" : "messages"} ready`
    : `message in ${messageState.winsRemaining} wins`;

  useEffect(() => {
    if (visibleMessages.length === 0 && visibleInteractions.length === 0) {
      return undefined;
    }

    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 500);

    return () => clearInterval(interval);
  }, [visibleMessages.length, visibleInteractions.length]);

  return (
    <section className="screen screen--game">
      <div className="game-paper-layout game-paper-layout--solo">
        <div className="game-main">
          <article className="hero-card board-sheet">
            <div className="board-sheet__top">
              <div>
                <p className="eyebrow">Round {session.round}</p>
                <h2>{boardTitle}</h2>
              </div>

              <div className="leave-cluster">
                <button
                  className="secondary-button scribble-link scribble-link--shy leave-dodge"
                  type="button"
                  onMouseEnter={onLeaveHover}
                  onClick={onLeaveAttempt}
                  style={{ "--leave-x": `${leaveOffset.x}px`, "--leave-y": `${leaveOffset.y}px` }}
                >
                  leave
                </button>
                {leaveTease && <p className="leave-tease">{leaveTease}</p>}
              </div>
            </div>

            <div className="board-players">
              <span className={session.currentTurnPlayerId === selfId ? "board-players__item board-players__item--active" : "board-players__item"}>
                you {self?.symbol === "HEART" ? HEART : CROSS} <em>{self?.winCount ?? 0} wins</em>
              </span>
              <span className="board-players__divider">/</span>
              <span
                className={
                  session.currentTurnPlayerId === opponent?.id
                    ? "board-players__item board-players__item--active"
                    : "board-players__item"
                }
              >
                {opponent?.name ?? "match"} {opponent?.symbol === "HEART" ? HEART : CROSS} <em>{opponent?.winCount ?? 0} wins</em>
              </span>
            </div>

            <Board
              board={session.board}
              winningLine={session.winningLine}
              yourTurn={isYourTurn}
              yourSymbol={self?.symbol}
              winnerSymbol={winnerSymbol}
              phase={session.phase}
              onMove={onMove}
            />
            <LiveInteractionLayer interactions={visibleInteractions} />
            <LiveMessageLayer messages={visibleMessages} selfId={selfId} />
            {session.phase === "draw" && (
              <div className="draw-reset-note">
                <span>draw</span>
                <strong>next round in 3</strong>
              </div>
            )}

            <div className="board-bottom-row">
              <div className="board-bottom-copy">
                <p className="board-turn-note">{boardCaption}</p>
                <span className={`board-unlock-note ${messageState.unlocked ? "board-unlock-note--open" : ""}`}>
                  {messageLabel}
                </span>
              </div>
              <div className="board-mini-actions">
                {hasAnswers && (
                  <button
                    className={`ghost-button scribble-link ${detailPanel === "answers" ? "scribble-link--active" : ""}`}
                    type="button"
                    onClick={() => setDetailPanel((current) => (current === "answers" ? null : "answers"))}
                  >
                    answers
                  </button>
                )}
              </div>
            </div>

            {messageState.available > 0 && (
              <BubbleComposer
                maxCharacters={messageState.maxCharacters}
                value={chatInput}
                onChange={onChatInput}
                onSubmit={onChatSubmit}
              />
            )}

            {detailPanel === "answers" && (
              <article className="panel paper-note detail-sheet">
                <div className="panel__header">
                  <h3>answers</h3>
                  <span>Only what the board already opened.</span>
                </div>

                <div className="history-list">
                  {session.interactionHistory.length === 0 && (
                    <div className="history-empty">Nothing yet.</div>
                  )}

                  {session.interactionHistory
                    .filter((item) => item.questionText || item.answerText)
                    .map((item) => (
                      <article key={item.id} className={`history-item history-item--${item.result}`}>
                        <div className="history-item__meta">
                          <span>Round {item.roundNumber}</span>
                          <strong>{item.result === "draw" ? "Draw" : "Question"}</strong>
                        </div>
                        <p>{item.questionText}</p>
                        {item.answerText ? <blockquote>{item.answerText}</blockquote> : <small>No stored answer.</small>}
                      </article>
                    ))}
                </div>
              </article>
            )}
          </article>
        </div>
      </div>

      {session.phase === "question-pick" && (
        <Modal
          title={pickerName}
          subtitle={
            isWinner
              ? "pick one"
              : "picking..."
          }
        >
          {isWinner ? (
            <div className="modal-card-grid">
              {session.promptOptions.map((prompt) => (
                <button
                  key={prompt.id}
                  className="prompt-card"
                  type="button"
                  onClick={() => onQuestionSelect(prompt.id)}
                >
                  <span>{prompt.category}</span>
                  <strong>{prompt.text}</strong>
                </button>
              ))}
            </div>
          ) : (
            <div className="modal-placeholder">picking...</div>
          )}
        </Modal>
      )}

      {session.phase === "answering" && (
        <Modal
          title={responderName}
          subtitle={isLoser ? session.selectedQuestion?.text : answerStatus}
        >
          {isLoser ? (
            <form className="answer-form" onSubmit={onAnswerSubmit}>
              <textarea
                value={answerInput}
                maxLength={ANSWER_CHARACTER_LIMIT}
                placeholder="25 max"
                onChange={(event) => onAnswerInput(event.target.value.slice(0, ANSWER_CHARACTER_LIMIT))}
              />
              <div className="chat-form__footer">
                <span className={countCharacters(answerInput) > ANSWER_CHARACTER_LIMIT ? "warning-text" : ""}>
                  {countCharacters(answerInput)} / {ANSWER_CHARACTER_LIMIT}
                </span>
                <button className="primary-button scribble-action scribble-action--small" type="submit">
                  send answer
                </button>
              </div>
            </form>
          ) : (
            <div className="modal-placeholder">{answerStatus}</div>
          )}
        </Modal>
      )}

    </section>
  );
}

function InviteDock({
  invite,
  inviteCodeInput,
  onInviteCodeChange,
  onGenerateInvite,
  onShareLink,
  onJoinByCode,
  flavorLine,
  locked
}) {
  return (
    <article className="panel paper-note invite-dock">
      <div className="panel__header">
        <h3>play with someone</h3>
        <span>{flavorLine}</span>
      </div>

      <div className="paper-code-card">
        <span>code</span>
        <strong>{invite?.code ?? "none yet"}</strong>
      </div>

      <label className="paper-field paper-field--compact">
        <span>Enter code</span>
        <input
          type="text"
          value={inviteCodeInput}
          placeholder="write code here"
          disabled={locked}
          onChange={(event) => onInviteCodeChange(event.target.value)}
        />
      </label>

      <div className="scribble-actions scribble-actions--compact">
        <button className="primary-button scribble-action scribble-action--small" type="button" onClick={onGenerateInvite} disabled={locked}>
          make
        </button>
        <button className="secondary-button scribble-link" type="button" onClick={onShareLink}>
          copy
        </button>
        <button className="ghost-button scribble-link" type="button" onClick={onJoinByCode} disabled={locked}>
          join
        </button>
      </div>
      {locked && <p className="invite-lock-note">Private codes open again between matches, not during a live round.</p>}
    </article>
  );
}

function Board({ board, winningLine, yourTurn, yourSymbol, winnerSymbol, phase, onMove }) {
  return (
    <div className="board-shell">
      <div className="board-stage">
        <span className="board-grid-line board-grid-line--v-one" aria-hidden="true" />
        <span className="board-grid-line board-grid-line--v-two" aria-hidden="true" />
        <span className="board-grid-line board-grid-line--h-one" aria-hidden="true" />
        <span className="board-grid-line board-grid-line--h-two" aria-hidden="true" />
        {board.map((cell, index) => {
          const filled = Boolean(cell);
          const highlighted = winningLine?.includes(index);
          const falling = phase === "question-pick" && winnerSymbol && filled && cell !== winnerSymbol;
          const winningMark = phase === "question-pick" && highlighted;

          return (
            <button
              key={index}
              className={`board-cell ${filled ? "board-cell--filled" : ""} ${highlighted ? "board-cell--highlighted" : ""}`}
              type="button"
              disabled={!yourTurn || filled}
              onClick={() => onMove(index)}
            >
              <span className="board-cell__inner">
                {!filled && yourTurn && <span className="board-cell__hint">{yourSymbol === "HEART" ? HEART : CROSS}</span>}
                {cell === "X" && (
                  <span className={`mark-x ${falling ? "board-mark--fall" : ""} ${winningMark ? "board-mark--winner" : ""}`} aria-hidden="true">
                    <span />
                    <span />
                  </span>
                )}
                {cell === "HEART" && (
                  <span className={`mark-heart ${falling ? "board-mark--fall" : ""} ${winningMark ? "board-mark--winner" : ""}`} aria-hidden="true">
                    {HEART}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Modal({ title, subtitle, children }) {
  return (
    <div className="modal-layer">
      <div className="modal-card">
        <h3>{title}</h3>
        <p className="modal-subtitle">{subtitle}</p>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function CursorAura() {
  const orbRef = useRef(null);
  const dotRef = useRef(null);

  useEffect(() => {
    if (!window.matchMedia("(pointer: fine)").matches) {
      return undefined;
    }

    const orb = orbRef.current;
    const dot = dotRef.current;

    if (!orb || !dot) {
      return undefined;
    }

    let currentX = window.innerWidth / 2;
    let currentY = window.innerHeight / 2;
    let targetX = currentX;
    let targetY = currentY;
    let frame = 0;

    const animate = () => {
      currentX += (targetX - currentX) * 0.18;
      currentY += (targetY - currentY) * 0.18;
      const scale = orb.dataset.pressed === "true" ? 0.86 : 1;

      orb.style.transform = `translate3d(${currentX - 18}px, ${currentY - 18}px, 0) scale(${scale})`;
      dot.style.transform = `translate3d(${targetX - 4}px, ${targetY - 4}px, 0)`;

      frame = window.requestAnimationFrame(animate);
    };

    const show = () => {
      orb.dataset.visible = "true";
      dot.dataset.visible = "true";
    };

    const hide = () => {
      orb.dataset.visible = "false";
      dot.dataset.visible = "false";
    };

    const handleMove = (event) => {
      targetX = event.clientX;
      targetY = event.clientY;
      show();
    };

    const handleDown = () => {
      orb.dataset.pressed = "true";
    };

    const handleUp = () => {
      orb.dataset.pressed = "false";
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mousedown", handleDown);
    window.addEventListener("mouseup", handleUp);
    window.addEventListener("mouseleave", hide);
    window.addEventListener("mouseenter", show);

    frame = window.requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mousedown", handleDown);
      window.removeEventListener("mouseup", handleUp);
      window.removeEventListener("mouseleave", hide);
      window.removeEventListener("mouseenter", show);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <>
      <span ref={orbRef} className="cursor-orb" aria-hidden="true" />
      <span ref={dotRef} className="cursor-dot" aria-hidden="true" />
    </>
  );
}

function ToastRack({ toasts }) {
  return (
    <div className="toast-rack">
      {toasts.map((toast) => (
        <article key={toast.id} className={`toast toast--${toast.tone ?? "info"}`}>
          {toast.message}
        </article>
      ))}
    </div>
  );
}

export default App;
