import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { questionPrompts } from "../../shared/content.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(currentDir, "../data");

mkdirSync(dataDir, { recursive: true });

export const dbPath = resolve(dataDir, "lovelock.json");

function createDefaultState() {
  return {
    users: {},
    sessions: {},
    questionBank: questionPrompts.map((item) => ({
      id: item.id,
      category: item.category,
      prompt: item.text
    })),
    interactionHistory: [],
    answers: [],
    chatMessages: []
  };
}

function readState() {
  if (!existsSync(dbPath)) {
    return createDefaultState();
  }

  try {
    const raw = readFileSync(dbPath, "utf8");
    const parsed = JSON.parse(raw);

    return {
      ...createDefaultState(),
      ...parsed
    };
  } catch {
    return createDefaultState();
  }
}

const state = readState();

function writeState() {
  writeFileSync(dbPath, JSON.stringify(state, null, 2), "utf8");
}

function syncQuestionBank() {
  const questionMap = new Map(state.questionBank.map((item) => [item.id, item]));

  questionPrompts.forEach((item) => {
    questionMap.set(item.id, {
      id: item.id,
      category: item.category,
      prompt: item.text
    });
  });

  state.questionBank = [...questionMap.values()];
  writeState();
}

syncQuestionBank();

export function upsertPlayer(player) {
  state.users[player.id] = {
    id: player.id,
    authToken: player.authToken,
    name: player.name,
    gender: player.gender,
    createdAt: player.createdAt,
    updatedAt: player.updatedAt
  };
  writeState();
}

export function createSessionRecord(session) {
  state.sessions[session.id] = {
    id: session.id,
    inviteCode: session.inviteCode,
    sessionType: session.type,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    endedAt: null
  };
  writeState();
}

export function finishSessionRecord(id, status = "completed") {
  const timestamp = new Date().toISOString();
  const existing = state.sessions[id] ?? {
    id
  };

  state.sessions[id] = {
    ...existing,
    status,
    updatedAt: timestamp,
    endedAt: timestamp
  };

  writeState();
}

export function saveInteractionHistory(interaction) {
  state.interactionHistory.push({
    id: interaction.id,
    sessionId: interaction.sessionId,
    roundNumber: interaction.roundNumber,
    winnerPlayerId: interaction.winnerPlayerId,
    loserPlayerId: interaction.loserPlayerId,
    result: interaction.result,
    questionId: interaction.questionId,
    questionText: interaction.questionText,
    questionCategory: interaction.questionCategory,
    answerText: interaction.answerText,
    responderPlayerId: interaction.responderPlayerId,
    createdAt: interaction.createdAt
  });

  if (interaction.result === "win" && interaction.answerText) {
    state.answers.push({
      id: interaction.answerId,
      interactionId: interaction.id,
      sessionId: interaction.sessionId,
      responderPlayerId: interaction.responderPlayerId,
      questionId: interaction.questionId,
      answerText: interaction.answerText,
      createdAt: interaction.createdAt
    });
  }

  writeState();
}

export function saveChatMessage(message) {
  state.chatMessages.push({
    id: message.id,
    sessionId: message.sessionId,
    playerId: message.playerId,
    content: message.content,
    stage: message.stage,
    createdAt: message.createdAt
  });
  writeState();
}
