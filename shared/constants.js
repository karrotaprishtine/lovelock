export const APP_NAME = "Lovelock";

export const GENDERS = ["male", "female"];

export const ANSWER_CHARACTER_LIMIT = 25;
export const MESSAGE_CHARACTER_LIMIT = 50;
export const MESSAGE_UNLOCK_WINS = 3;

export const INVITE_CODE_LENGTH = 6;

export const WIN_PATTERNS = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6]
];

export const SERVER_EVENTS = {
  RESUME_PLAYER: "resume-player",
  ENTER_LOVELOCK: "enter-lovelock",
  GENERATE_INVITE: "generate-invite",
  JOIN_INVITE: "join-invite",
  MAKE_MOVE: "make-move",
  SELECT_QUESTION: "select-question",
  ANSWER_TYPING: "answer-typing",
  SUBMIT_ANSWER: "submit-answer",
  SEND_CHAT: "send-chat",
  REQUEST_REMATCH: "request-rematch",
  LEAVE_FLOW: "leave-flow",
  STATE_UPDATE: "state:update",
  TOAST: "toast"
};

export const PLAYER_STATUS = {
  IDLE: "idle",
  WAITING: "waiting",
  MATCHED: "matched",
  DISCONNECTED: "disconnected"
};

export const SESSION_PHASE = {
  WAITING: "waiting",
  PLAYING: "playing",
  QUESTION_PICK: "question-pick",
  ANSWERING: "answering",
  DRAW: "draw"
};

export function getOppositeGender(gender) {
  return gender === "male" ? "female" : "male";
}

export function countCharacters(text = "") {
  return String(text).length;
}

export function getMessageState(winCount = 0, sentCount = 0) {
  const wins = Math.max(0, winCount);
  const sent = Math.max(0, sentCount);
  const earnedCount = Math.floor(wins / MESSAGE_UNLOCK_WINS);
  const available = Math.max(0, earnedCount - sent);
  const winsSinceLastSpentCredit = Math.max(0, wins - sent * MESSAGE_UNLOCK_WINS);

  return {
    unlocked: available > 0,
    winCount: wins,
    sentCount: sent,
    earnedCount,
    available,
    winsRemaining: available > 0 ? 0 : Math.max(0, MESSAGE_UNLOCK_WINS - winsSinceLastSpentCredit),
    maxCharacters: MESSAGE_CHARACTER_LIMIT
  };
}
