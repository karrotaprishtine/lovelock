import http from "node:http";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import cors from "cors";
import express from "express";
import { nanoid } from "nanoid";
import { Server } from "socket.io";

import {
  ANSWER_CHARACTER_LIMIT,
  GENDERS,
  INVITE_CODE_LENGTH,
  MESSAGE_UNLOCK_WINS,
  PLAYER_STATUS,
  SERVER_EVENTS,
  SESSION_PHASE,
  WIN_PATTERNS,
  countCharacters,
  getMessageState,
  getOppositeGender
} from "../../shared/constants.js";
import { buttonMessages, leaveMessages, outcomeMessages, questionPrompts, waitingMessages } from "../../shared/content.js";
import { createSessionRecord, dbPath, finishSessionRecord, saveChatMessage, saveInteractionHistory, upsertPlayer } from "./db.js";

const PORT = Number(process.env.PORT ?? 4000);
const currentDir = dirname(fileURLToPath(import.meta.url));
const clientDistDir = resolve(currentDir, "../../client/dist");
const hasBuiltClient = existsSync(resolve(clientDistDir, "index.html"));
const CLIENT_URL =
  process.env.CLIENT_URL ??
  process.env.RENDER_EXTERNAL_URL ??
  "http://localhost:5173";
const DISCONNECT_GRACE_MS = 45_000;
const corsOptions = {
  origin: true,
  credentials: true
};

const publicQueue = {
  male: [],
  female: []
};

const playersById = new Map();
const playerIdsByAuthToken = new Map();
const sessions = new Map();
const inviteCodes = new Map();
const disconnectTimeouts = new Map();

const app = express();

app.use(
  cors(corsOptions)
);

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    queue: {
      male: publicQueue.male.length,
      female: publicQueue.female.length
    },
    liveSessions: sessions.size,
    dbPath
  });
});

if (hasBuiltClient) {
  app.use(express.static(clientDistDir));

  app.get("*", (request, response, next) => {
    if (request.path.startsWith("/socket.io") || request.path === "/health") {
      next();
      return;
    }

    response.sendFile(resolve(clientDistDir, "index.html"));
  });
}

const server = http.createServer(app);

const io = new Server(server, {
  cors: corsOptions
});

function nowIso() {
  return new Date().toISOString();
}

function randomFrom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function shuffle(items) {
  return [...items]
    .map((item) => ({ item, order: Math.random() }))
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.item);
}

function sanitizeName(name = "") {
  return name.replace(/\s+/g, " ").trim().slice(0, 24);
}

function normalizeGender(gender) {
  return typeof gender === "string" && GENDERS.includes(gender.toLowerCase()) ? gender.toLowerCase() : null;
}

function generateInviteCode() {
  return nanoid(INVITE_CODE_LENGTH).replace(/[_-]/g, "X").toUpperCase();
}

function getPlayer(playerId) {
  return playersById.get(playerId) ?? null;
}

function getSocketForPlayer(playerId) {
  const player = getPlayer(playerId);
  return player?.socketId ? io.sockets.sockets.get(player.socketId) ?? null : null;
}

function getPlayerWinCount(session, playerId) {
  return session.interactions.filter((item) => item.result === "win" && item.winnerPlayerId === playerId).length;
}

function getPlayerSentMessageCount(session, playerId) {
  return session.chatMessages.filter((item) => item.playerId === playerId).length;
}

function serializePlayer(player, session) {
  return {
    id: player.id,
    name: player.name,
    gender: player.gender,
    connected: player.connected,
    status: player.status,
    inviteCode: player.inviteCode,
    symbol: session?.symbolByPlayerId[player.id] ?? null,
    winCount: session ? getPlayerWinCount(session, player.id) : 0
  };
}

function clearDisconnectTimeout(playerId) {
  const timeout = disconnectTimeouts.get(playerId);

  if (timeout) {
    clearTimeout(timeout);
    disconnectTimeouts.delete(playerId);
  }
}

function removeFromQueue(playerId) {
  publicQueue.male = publicQueue.male.filter((entry) => entry !== playerId);
  publicQueue.female = publicQueue.female.filter((entry) => entry !== playerId);
}

function clearInviteCode(player) {
  if (player.inviteCode) {
    inviteCodes.delete(player.inviteCode);
    player.inviteCode = null;
  }
}

function sendToast(playerId, tone, message) {
  const socket = getSocketForPlayer(playerId);

  if (socket) {
    socket.emit(SERVER_EVENTS.TOAST, {
      id: nanoid(10),
      tone,
      message
    });
  }
}

function buildWaitingState(player) {
  return {
    mode: "waiting",
    self: {
      id: player.id,
      name: player.name,
      gender: player.gender,
      authToken: player.authToken
    },
    waiting: {
      title: "Searching for your match",
      message: randomFrom(waitingMessages),
      accent: randomFrom(buttonMessages),
      quote: randomFrom(leaveMessages)
    },
    invite: {
      code: player.inviteCode,
      shareLink: player.inviteCode ? `${CLIENT_URL}?code=${player.inviteCode}` : null
    }
  };
}

function buildEntryState(player = null) {
  return {
    mode: "entry",
    self: player
      ? {
          id: player.id,
          name: player.name,
          gender: player.gender,
          authToken: player.authToken
        }
      : null
  };
}

function buildSessionState(session, viewerId) {
  const viewer = getPlayer(viewerId);
  const viewerWins = getPlayerWinCount(session, viewerId);
  const sentMessages = getPlayerSentMessageCount(session, viewerId);
  const messageState = getMessageState(viewerWins, sentMessages);
  const opponentId = session.players.find((playerId) => playerId !== viewerId);
  const opponent = opponentId ? getPlayer(opponentId) : null;

  return {
    mode: "game",
    self: {
      id: viewer.id,
      name: viewer.name,
      gender: viewer.gender,
      authToken: viewer.authToken
    },
    flavor: {
      primaryButton: randomFrom(buttonMessages),
      leaveNudge: randomFrom(leaveMessages)
    },
    session: {
      id: session.id,
      type: session.type,
      round: session.round,
      phase: session.phase,
      board: session.board,
      starterPlayerId: session.starterPlayerId,
      currentTurnPlayerId: session.currentTurnPlayerId,
      winningLine: session.winningLine,
      lastOutcome: session.lastOutcome,
      answerCharacterLimit: ANSWER_CHARACTER_LIMIT,
      promptOptions: viewerId === session.pendingWinnerPlayerId ? session.promptOptions : [],
      selectedQuestion: session.selectedQuestion,
      drawQuestion: session.drawQuestion,
      pendingWinnerPlayerId: session.pendingWinnerPlayerId,
      pendingLoserPlayerId: session.pendingLoserPlayerId,
      inviteCode: session.inviteCode,
      players: session.players.map((playerId) => serializePlayer(getPlayer(playerId), session)),
      opponent: opponent ? serializePlayer(opponent, session) : null,
      interactionHistory: [...session.interactions].slice(-6).reverse(),
      message: {
        unlocked: messageState.unlocked,
        winCount: messageState.winCount,
        winsRemaining: messageState.winsRemaining,
        unlockWins: MESSAGE_UNLOCK_WINS,
        maxCharacters: messageState.maxCharacters,
        available: messageState.available,
        messages: session.chatMessages.slice(-30)
      },
      connectionWarning: session.players
        .map((playerId) => getPlayer(playerId))
        .filter(Boolean)
        .find((player) => !player.connected)?.name
        ? `${session.players
            .map((playerId) => getPlayer(playerId))
            .filter(Boolean)
            .find((player) => !player.connected).name} is reconnecting...`
        : null
    },
    invite: {
      code: session.inviteCode,
      shareLink: session.inviteCode ? `${CLIENT_URL}?code=${session.inviteCode}` : null
    }
  };
}

function emitStateToPlayer(playerId) {
  const player = getPlayer(playerId);
  const socket = getSocketForPlayer(playerId);

  if (!player || !socket) {
    return;
  }

  const payload = player.sessionId && sessions.has(player.sessionId)
    ? buildSessionState(sessions.get(player.sessionId), playerId)
    : player.status === PLAYER_STATUS.WAITING
      ? buildWaitingState(player)
      : buildEntryState(player);

  socket.emit(SERVER_EVENTS.STATE_UPDATE, payload);
}

function emitStateToSession(session) {
  session.players.forEach((playerId) => emitStateToPlayer(playerId));
}

function createPlayer(socket, { name, gender }) {
  const timestamp = nowIso();
  const player = {
    id: nanoid(12),
    authToken: nanoid(24),
    socketId: socket.id,
    name,
    gender,
    status: PLAYER_STATUS.IDLE,
    connected: true,
    sessionId: null,
    inviteCode: null,
    chatWindow: [],
    lastChatAt: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  playersById.set(player.id, player);
  playerIdsByAuthToken.set(player.authToken, player.id);
  socket.data.playerId = player.id;
  upsertPlayer(player);

  return player;
}

function attachPlayerToSocket(player, socket) {
  player.socketId = socket.id;
  player.connected = true;
  player.updatedAt = nowIso();
  socket.data.playerId = player.id;
  clearDisconnectTimeout(player.id);
  upsertPlayer(player);
}

function getReusablePlayer(authToken) {
  if (!authToken) {
    return null;
  }

  const playerId = playerIdsByAuthToken.get(authToken);

  return playerId ? getPlayer(playerId) : null;
}

function playerCanAutoMatch(player) {
  return Boolean(player) && player.connected && !player.sessionId && !player.inviteCode;
}

function dequeuePublicMatch(targetGender) {
  while (publicQueue[targetGender].length > 0) {
    const candidateId = publicQueue[targetGender].shift();
    const candidate = getPlayer(candidateId);

    if (playerCanAutoMatch(candidate) && candidate.status === PLAYER_STATUS.WAITING) {
      return candidate;
    }
  }

  return null;
}

function startRound(session, starterPlayerId, incrementRound = false) {
  const secondPlayerId = session.players.find((playerId) => playerId !== starterPlayerId);

  if (incrementRound) {
    session.round += 1;
  }

  session.board = Array(9).fill(null);
  session.phase = SESSION_PHASE.PLAYING;
  session.starterPlayerId = starterPlayerId;
  session.currentTurnPlayerId = starterPlayerId;
  session.symbolByPlayerId = {
    [starterPlayerId]: "X",
    [secondPlayerId]: "HEART"
  };
  session.winningLine = [];
  session.promptOptions = [];
  session.selectedQuestion = null;
  session.drawQuestion = null;
  session.pendingWinnerPlayerId = null;
  session.pendingLoserPlayerId = null;
  session.lastOutcome = null;
  session.updatedAt = nowIso();
}

function createSession(firstPlayer, secondPlayer, type = "auto", inviteCode = null) {
  removeFromQueue(firstPlayer.id);
  removeFromQueue(secondPlayer.id);
  clearInviteCode(firstPlayer);
  clearInviteCode(secondPlayer);

  const starterPlayerId = Math.random() > 0.5 ? firstPlayer.id : secondPlayer.id;
  const timestamp = nowIso();
  const session = {
    id: nanoid(12),
    type,
    inviteCode,
    status: "active",
    round: 1,
    players: [firstPlayer.id, secondPlayer.id],
    board: Array(9).fill(null),
    phase: SESSION_PHASE.PLAYING,
    starterPlayerId,
    currentTurnPlayerId: starterPlayerId,
    symbolByPlayerId: {},
    winningLine: [],
    promptOptions: [],
    selectedQuestion: null,
    drawQuestion: null,
    pendingWinnerPlayerId: null,
    pendingLoserPlayerId: null,
    interactions: [],
    chatMessages: [],
    usedQuestionIds: new Set(),
    lastOutcome: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  firstPlayer.status = PLAYER_STATUS.MATCHED;
  secondPlayer.status = PLAYER_STATUS.MATCHED;
  firstPlayer.sessionId = session.id;
  secondPlayer.sessionId = session.id;
  firstPlayer.updatedAt = timestamp;
  secondPlayer.updatedAt = timestamp;
  sessions.set(session.id, session);

  startRound(session, starterPlayerId, false);
  createSessionRecord(session);
  emitStateToSession(session);
}

function queuePlayerForMatch(player) {
  removeFromQueue(player.id);
  clearInviteCode(player);

  const preferredQueue = getOppositeGender(player.gender);
  const opponent = dequeuePublicMatch(preferredQueue);

  if (opponent && opponent.id !== player.id) {
    createSession(opponent, player, "auto");
    return;
  }

  player.status = PLAYER_STATUS.WAITING;
  player.updatedAt = nowIso();
  publicQueue[player.gender].push(player.id);
  emitStateToPlayer(player.id);
}

function createInviteForPlayer(player) {
  if (player.sessionId) {
    sendToast(player.id, "warning", "Finish the current game before creating a love code.");
    return;
  }

  removeFromQueue(player.id);

  let code = player.inviteCode;

  if (!code) {
    do {
      code = generateInviteCode();
    } while (inviteCodes.has(code));
  }

  player.inviteCode = code;
  player.status = PLAYER_STATUS.WAITING;
  player.updatedAt = nowIso();
  inviteCodes.set(code, player.id);
  emitStateToPlayer(player.id);
  sendToast(player.id, "success", `Love code ${code} is ready to share.`);
}

function joinInviteWithCode(player, rawCode) {
  const code = String(rawCode ?? "").trim().toUpperCase();

  if (player.sessionId) {
    sendToast(player.id, "warning", "Finish or leave your current match before joining a new secret one.");
    return;
  }

  if (!code) {
    sendToast(player.id, "warning", "Enter a valid love code first.");
    return;
  }

  const hostPlayerId = inviteCodes.get(code);
  const hostPlayer = hostPlayerId ? getPlayer(hostPlayerId) : null;

  if (!hostPlayer || hostPlayer.id === player.id || hostPlayer.sessionId) {
    sendToast(player.id, "warning", "That love code is no longer available.");
    return;
  }

  if (hostPlayer.gender === player.gender) {
    sendToast(player.id, "warning", "Lovelock only pairs male players with female players.");
    return;
  }

  removeFromQueue(player.id);
  clearInviteCode(player);
  clearInviteCode(hostPlayer);
  createSession(hostPlayer, player, "invite", code);
}

function findWinningLine(board) {
  return WIN_PATTERNS.find(([first, second, third]) => {
    return board[first] && board[first] === board[second] && board[first] === board[third];
  }) ?? null;
}

function pickQuestionOptions(session) {
  const availablePrompts = questionPrompts.filter((item) => !session.usedQuestionIds.has(item.id));
  const pool = availablePrompts.length >= 2 ? availablePrompts : questionPrompts;
  const shuffled = shuffle(pool);
  const first = shuffled[0];
  const second = shuffled.find((item) => item.id !== first.id && item.category !== first.category) ?? shuffled[1];

  return [first, second].filter(Boolean);
}

function getOpponentId(session, playerId) {
  return session.players.find((entry) => entry !== playerId);
}

function leaveSession(player, abandonReason = "abandoned") {
  removeFromQueue(player.id);
  clearInviteCode(player);

  if (!player.sessionId || !sessions.has(player.sessionId)) {
    player.status = PLAYER_STATUS.IDLE;
    player.updatedAt = nowIso();
    emitStateToPlayer(player.id);
    return;
  }

  const session = sessions.get(player.sessionId);
  const opponentId = getOpponentId(session, player.id);
  const opponent = opponentId ? getPlayer(opponentId) : null;

  finishSessionRecord(session.id, abandonReason);
  sessions.delete(session.id);
  player.sessionId = null;
  player.status = PLAYER_STATUS.IDLE;
  player.updatedAt = nowIso();
  emitStateToPlayer(player.id);

  if (opponent) {
    opponent.sessionId = null;
    opponent.status = PLAYER_STATUS.WAITING;
    opponent.updatedAt = nowIso();
    sendToast(opponent.id, "warning", `${player.name} slipped away. We're finding you someone new.`);
    queuePlayerForMatch(opponent);
  }
}

function registerOrResumePlayer(socket, payload) {
  const name = sanitizeName(payload?.name ?? "");
  const gender = normalizeGender(payload?.gender);

  if (!name || !gender) {
    sendToast(socket.data.playerId, "warning", "Enter a name and choose a gender to begin.");
    return null;
  }

  const reusablePlayer = getReusablePlayer(payload?.authToken);

  if (reusablePlayer) {
    attachPlayerToSocket(reusablePlayer, socket);
    reusablePlayer.name = name;
    reusablePlayer.gender = gender;
    reusablePlayer.updatedAt = nowIso();
    upsertPlayer(reusablePlayer);
    return reusablePlayer;
  }

  return createPlayer(socket, { name, gender });
}

function handleMove(player, cellIndex) {
  const session = player.sessionId ? sessions.get(player.sessionId) : null;

  if (!session || session.phase !== SESSION_PHASE.PLAYING) {
    return;
  }

  if (player.id !== session.currentTurnPlayerId) {
    sendToast(player.id, "warning", "Wait for your turn. Let the tension breathe.");
    return;
  }

  if (typeof cellIndex !== "number" || cellIndex < 0 || cellIndex > 8 || session.board[cellIndex]) {
    return;
  }

  session.board[cellIndex] = session.symbolByPlayerId[player.id];
  session.updatedAt = nowIso();

  const winningLine = findWinningLine(session.board);

  if (winningLine) {
    const loserPlayerId = getOpponentId(session, player.id);
    session.phase = SESSION_PHASE.QUESTION_PICK;
    session.winningLine = winningLine;
    session.promptOptions = pickQuestionOptions(session);
    session.pendingWinnerPlayerId = player.id;
    session.pendingLoserPlayerId = loserPlayerId;
    session.lastOutcome = {
      winner: randomFrom(outcomeMessages.win),
      loser: randomFrom(outcomeMessages.lose)
    };
    emitStateToSession(session);
    return;
  }

  if (session.board.every(Boolean)) {
    session.phase = SESSION_PHASE.DRAW;
    session.drawQuestion = null;
    session.lastOutcome = {
      draw: randomFrom(outcomeMessages.draw)
    };
    session.interactions.push({
      id: nanoid(12),
      sessionId: session.id,
      roundNumber: session.round,
      winnerPlayerId: null,
      loserPlayerId: null,
      result: "draw",
      questionId: null,
      questionText: null,
      questionCategory: null,
      answerText: null,
      responderPlayerId: null,
      createdAt: nowIso()
    });
    saveInteractionHistory(session.interactions[session.interactions.length - 1]);
    emitStateToSession(session);
    return;
  }

  session.currentTurnPlayerId = getOpponentId(session, player.id);
  emitStateToSession(session);
}

function handleQuestionSelection(player, questionId) {
  const session = player.sessionId ? sessions.get(player.sessionId) : null;

  if (!session || session.phase !== SESSION_PHASE.QUESTION_PICK || player.id !== session.pendingWinnerPlayerId) {
    return;
  }

  const selectedQuestion = session.promptOptions.find((prompt) => prompt.id === questionId);

  if (!selectedQuestion) {
    sendToast(player.id, "warning", "Choose one of the unlocked prompts.");
    return;
  }

  session.selectedQuestion = selectedQuestion;
  session.phase = SESSION_PHASE.ANSWERING;
  session.updatedAt = nowIso();
  emitStateToSession(session);
}

function handleAnswerSubmission(player, answerText) {
  const session = player.sessionId ? sessions.get(player.sessionId) : null;
  const rawAnswer = String(answerText ?? "");
  const normalizedAnswer = rawAnswer.replace(/\s+/g, " ").trim();
  const characters = countCharacters(rawAnswer);

  if (!session || session.phase !== SESSION_PHASE.ANSWERING || player.id !== session.pendingLoserPlayerId) {
    return;
  }

  if (!normalizedAnswer || characters > ANSWER_CHARACTER_LIMIT) {
    sendToast(player.id, "warning", `Keep your answer within ${ANSWER_CHARACTER_LIMIT}.`);
    return;
  }

  const interaction = {
    id: nanoid(12),
    answerId: nanoid(12),
    sessionId: session.id,
    roundNumber: session.round,
    winnerPlayerId: session.pendingWinnerPlayerId,
    loserPlayerId: session.pendingLoserPlayerId,
    result: "win",
    questionId: session.selectedQuestion.id,
    questionText: session.selectedQuestion.text,
    questionCategory: session.selectedQuestion.category,
    answerText: normalizedAnswer,
    responderPlayerId: player.id,
    createdAt: nowIso()
  };

  session.interactions.push(interaction);
  session.usedQuestionIds.add(session.selectedQuestion.id);
  saveInteractionHistory(interaction);

  const winnerWins = getPlayerWinCount(session, session.pendingWinnerPlayerId);
  const sentMessages = getPlayerSentMessageCount(session, session.pendingWinnerPlayerId);
  const messageState = getMessageState(winnerWins, sentMessages);

  if (winnerWins % MESSAGE_UNLOCK_WINS === 0 && messageState.available > 0) {
    sendToast(
      session.pendingWinnerPlayerId,
      "success",
      winnerWins === MESSAGE_UNLOCK_WINS ? "Message unlocked. One message ready." : "One message ready."
    );
  }

  const nextStarterPlayerId = session.pendingLoserPlayerId;
  startRound(session, nextStarterPlayerId, true);
  emitStateToSession(session);
}

function handleRematch(player) {
  const session = player.sessionId ? sessions.get(player.sessionId) : null;

  if (!session || session.phase !== SESSION_PHASE.DRAW) {
    return;
  }

  const nextStarterPlayerId = getOpponentId(session, session.starterPlayerId);
  startRound(session, nextStarterPlayerId, true);
  emitStateToSession(session);
}

function canSendChat(player) {
  const timestamp = Date.now();
  player.chatWindow = player.chatWindow.filter((entry) => timestamp - entry < 12_000);

  if (player.lastChatAt && timestamp - player.lastChatAt < 1_200) {
    return false;
  }

  if (player.chatWindow.length >= 4) {
    return false;
  }

  player.chatWindow.push(timestamp);
  player.lastChatAt = timestamp;
  return true;
}

function handleChatMessage(player, rawContent) {
  const session = player.sessionId ? sessions.get(player.sessionId) : null;

  if (!session) {
    return;
  }

  const winCount = getPlayerWinCount(session, player.id);
  const sentMessages = getPlayerSentMessageCount(session, player.id);
  const messageState = getMessageState(winCount, sentMessages);

  if (!messageState.unlocked) {
    sendToast(player.id, "warning", `Win ${messageState.winsRemaining} more to earn one message.`);
    return;
  }

  const rawMessage = String(rawContent ?? "");
  const content = rawMessage.replace(/\s+/g, " ").trim();
  const characters = countCharacters(rawMessage);

  if (!content || characters > messageState.maxCharacters) {
    sendToast(player.id, "warning", `Message stays within ${messageState.maxCharacters}.`);
    return;
  }

  if (!canSendChat(player)) {
    sendToast(player.id, "warning", "Slow down. Let the room flirt back.");
    return;
  }

  const message = {
    id: nanoid(12),
    sessionId: session.id,
    playerId: player.id,
    authorName: player.name,
    content,
    stage: messageState.unlocked ? "unlocked" : "locked",
    createdAt: nowIso()
  };

  session.chatMessages.push(message);
  saveChatMessage(message);
  emitStateToSession(session);
}

function scheduleDisconnectCleanup(player) {
  clearDisconnectTimeout(player.id);

  const timeout = setTimeout(() => {
    const latestPlayer = getPlayer(player.id);

    if (!latestPlayer || latestPlayer.connected) {
      return;
    }

    if (latestPlayer.sessionId) {
      leaveSession(latestPlayer, "expired");
    } else {
      removeFromQueue(latestPlayer.id);
      clearInviteCode(latestPlayer);
      latestPlayer.status = PLAYER_STATUS.IDLE;
      latestPlayer.updatedAt = nowIso();
    }
  }, DISCONNECT_GRACE_MS);

  disconnectTimeouts.set(player.id, timeout);
}

io.on("connection", (socket) => {
  socket.emit(SERVER_EVENTS.STATE_UPDATE, buildEntryState());

  socket.on(SERVER_EVENTS.RESUME_PLAYER, ({ authToken } = {}) => {
    const player = getReusablePlayer(authToken);

    if (!player) {
      socket.emit(SERVER_EVENTS.STATE_UPDATE, buildEntryState());
      return;
    }

    attachPlayerToSocket(player, socket);

    if (player.sessionId && sessions.has(player.sessionId)) {
      emitStateToSession(sessions.get(player.sessionId));
    } else if (player.status === PLAYER_STATUS.WAITING) {
      emitStateToPlayer(player.id);
    } else {
      socket.emit(SERVER_EVENTS.STATE_UPDATE, buildEntryState(player));
    }
  });

  socket.on(SERVER_EVENTS.ENTER_LOVELOCK, (payload = {}) => {
    const player = registerOrResumePlayer(socket, payload);

    if (!player) {
      socket.emit(SERVER_EVENTS.STATE_UPDATE, buildEntryState());
      return;
    }

    if (player.sessionId && sessions.has(player.sessionId)) {
      emitStateToSession(sessions.get(player.sessionId));
      return;
    }

    if (payload?.inviteCode) {
      joinInviteWithCode(player, payload.inviteCode);
      return;
    }

    queuePlayerForMatch(player);
  });

  socket.on(SERVER_EVENTS.GENERATE_INVITE, () => {
    const player = getPlayer(socket.data.playerId);

    if (player) {
      createInviteForPlayer(player);
    }
  });

  socket.on(SERVER_EVENTS.JOIN_INVITE, ({ code } = {}) => {
    const player = getPlayer(socket.data.playerId);

    if (player) {
      joinInviteWithCode(player, code);
    }
  });

  socket.on(SERVER_EVENTS.MAKE_MOVE, ({ cellIndex } = {}) => {
    const player = getPlayer(socket.data.playerId);

    if (player) {
      handleMove(player, cellIndex);
    }
  });

  socket.on(SERVER_EVENTS.SELECT_QUESTION, ({ questionId } = {}) => {
    const player = getPlayer(socket.data.playerId);

    if (player) {
      handleQuestionSelection(player, questionId);
    }
  });

  socket.on(SERVER_EVENTS.SUBMIT_ANSWER, ({ answer } = {}) => {
    const player = getPlayer(socket.data.playerId);

    if (player) {
      handleAnswerSubmission(player, answer);
    }
  });

  socket.on(SERVER_EVENTS.SEND_CHAT, ({ message } = {}) => {
    const player = getPlayer(socket.data.playerId);

    if (player) {
      handleChatMessage(player, message);
    }
  });

  socket.on(SERVER_EVENTS.REQUEST_REMATCH, () => {
    const player = getPlayer(socket.data.playerId);

    if (player) {
      handleRematch(player);
    }
  });

  socket.on(SERVER_EVENTS.LEAVE_FLOW, () => {
    const player = getPlayer(socket.data.playerId);

    if (player) {
      leaveSession(player, "left");
    }
  });

  socket.on("disconnect", () => {
    const player = getPlayer(socket.data.playerId);

    if (!player) {
      return;
    }

    player.connected = false;
    player.updatedAt = nowIso();
    scheduleDisconnectCleanup(player);

    if (player.sessionId && sessions.has(player.sessionId)) {
      emitStateToSession(sessions.get(player.sessionId));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Lovelock server listening on http://localhost:${PORT}`);
});
