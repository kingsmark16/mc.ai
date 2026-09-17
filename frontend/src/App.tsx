import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type UIEvent,
} from "react";
import "./App.css";
import favImage from "./assets/fav.png";
import logoImage from "./assets/logo.png";
import {
  askQuestionStream,
  deleteDocument,
  getHealth,
  getApiErrorMessage,
  isTransientApiError,
  listSources,
  scheduleSessionCloseOnPageExit,
  touchSession,
  uploadDocument,
  type ChatMessage,
  type AskQuestionInput,
  type DeleteSourceResponse,
  type RagSource,
  type UploadResponse,
} from "./config/api";

const MarkdownContent = lazy(() => import("./MarkdownContent"));

const activeSourceStorageKey = "rag-active-source";
const activeSourcesStorageKey = "rag-active-sources";
const activeConversationStorageKey = "rag-active-conversation";
const conversationsStorageKey = "rag-conversations";
const welcomeModalStorageKey = "rag-welcome-dismissed-v1";
const maxDocumentSizeBytes = 10 * 1024 * 1024;
const maxStoredConversations = 20;
const maxStoredMessages = 50;
const sessionHeartbeatIntervalMs = 15 * 1_000;
const legalOperatorName = "MCANGHEL";
const legalContactEmail = "mcanghel.mac@gmail.com";
const legalEffectiveDate = "September 17, 2026";

function getCurrentTimestamp() {
  return Date.now();
}

const suggestedQuestions = [
  "What is this document about?",
  "What are the main topics?",
  "Summarize the key conclusions.",
];

type GenerationStatus = "idle" | "running" | "stopping";

type AskMutationInput = {
  input: AskQuestionInput;
  generationId: number;
};

type AskMutationResult = {
  answer: string;
  sources: RagSource[];
  cancelled: boolean;
  generationId: number;
};

type UploadProgress = {
  currentFile: number;
  totalFiles: number;
  percent: number;
};

type UploadBatchFailure = {
  filename: string;
  message: string;
  isTransient: boolean;
};

type UploadBatchResult = {
  successes: UploadResponse[];
  failures: UploadBatchFailure[];
};

type DeleteBatchFailure = {
  source: string;
  message: string;
};

type DeleteBatchResult = {
  successes: DeleteSourceResponse[];
  failures: DeleteBatchFailure[];
};

type StoredConversation = {
  id: string;
  title: string;
  source?: string;
  sources?: string[];
  messages: ChatMessage[];
  updatedAt: number;
};

type InitialConversationData = {
  conversations: StoredConversation[];
  activeConversationId: string;
  activeSources: string[];
  messages: ChatMessage[];
};

function historyStorageKey(source?: string) {
  return "rag-chat-history:" + (source || "all");
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const message = value as Record<string, unknown>;

  return (
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" &&
    message.content.trim().length > 0
  );
}

function loadStoredMessages(source?: string): ChatMessage[] {
  const stored = window.localStorage.getItem(historyStorageKey(source));

  if (!stored) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(stored);

    return Array.isArray(parsed) ? parsed.filter(isChatMessage).slice(-50) : [];
  } catch {
    return [];
  }
}

function createConversationId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return (
    "conversation-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

function getConversationTitle(messages: ChatMessage[]) {
  const firstQuestion = messages.find((message) => message.role === "user");

  if (!firstQuestion) {
    return "New conversation";
  }

  const normalizedQuestion = firstQuestion.content.replace(/\s+/g, " ").trim();

  return normalizedQuestion.length > 48
    ? normalizedQuestion.slice(0, 48).trimEnd() + "…"
    : normalizedQuestion;
}

function normalizeStoredMessages(messages: ChatMessage[]) {
  return messages.filter(isChatMessage).slice(-maxStoredMessages);
}

function normalizeSourceSelection(
  sources: string[] | undefined,
  legacySource?: string,
) {
  const candidates = sources?.length
    ? sources
    : legacySource
      ? [legacySource]
      : [];

  return [
    ...new Set(candidates.map((source) => source.trim()).filter(Boolean)),
  ];
}

function getConversationSources(conversation: StoredConversation) {
  return normalizeSourceSelection(conversation.sources, conversation.source);
}

function createEmptyConversation(sources: string[] = []): StoredConversation {
  const normalizedSources = normalizeSourceSelection(sources);

  return {
    id: createConversationId(),
    title: "New conversation",
    source: normalizedSources.length === 1 ? normalizedSources[0] : undefined,
    sources: normalizedSources,
    messages: [],
    updatedAt: getCurrentTimestamp(),
  };
}

function updateStoredConversation(
  conversations: StoredConversation[],
  conversationId: string,
  messages: ChatMessage[],
  sources: string[],
  updatedAt: number,
): StoredConversation[] {
  const conversationIndex = conversations.findIndex(
    (conversation) => conversation.id === conversationId,
  );

  if (conversationIndex < 0) {
    return conversations;
  }

  const storedMessages = normalizeStoredMessages(messages);
  const normalizedSources = normalizeSourceSelection(sources);
  const conversation = conversations[conversationIndex];
  const updatedConversation: StoredConversation = {
    ...conversation,
    title: storedMessages.length
      ? conversation.title === "New conversation"
        ? getConversationTitle(storedMessages)
        : conversation.title
      : "New conversation",
    source: normalizedSources.length === 1 ? normalizedSources[0] : undefined,
    sources: normalizedSources,
    messages: storedMessages,
    updatedAt,
  };
  const updatedConversations = conversations.map((item, index) =>
    index === conversationIndex ? updatedConversation : item,
  );

  return updatedConversations
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, maxStoredConversations);
}

function removePendingAssistant(messages: ChatMessage[]) {
  const lastMessage = messages[messages.length - 1];

  return lastMessage?.role === "assistant" && !lastMessage.content
    ? messages.slice(0, -1)
    : messages;
}

function completeAssistantMessage(
  messages: ChatMessage[],
  answer: string,
  sources: RagSource[],
) {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.role === "assistant") {
    return [
      ...messages.slice(0, -1),
      { role: "assistant" as const, content: answer, sources },
    ].slice(-maxStoredMessages);
  }

  return [
    ...messages,
    { role: "assistant" as const, content: answer, sources },
  ].slice(-maxStoredMessages);
}

function isStoredConversation(value: unknown): value is StoredConversation {
  if (!value || typeof value !== "object") {
    return false;
  }

  const conversation = value as Record<string, unknown>;
  const hasValidSources =
    conversation.sources === undefined ||
    (Array.isArray(conversation.sources) &&
      conversation.sources.every((source) => typeof source === "string"));

  return (
    typeof conversation.id === "string" &&
    typeof conversation.title === "string" &&
    (conversation.source === undefined ||
      typeof conversation.source === "string") &&
    hasValidSources &&
    Array.isArray(conversation.messages) &&
    typeof conversation.updatedAt === "number"
  );
}

function loadStoredConversations(): StoredConversation[] {
  const stored = window.localStorage.getItem(conversationsStorageKey);

  if (!stored) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(stored);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(isStoredConversation)
      .map((conversation) => {
        const sources = normalizeSourceSelection(
          conversation.sources,
          conversation.source,
        );

        return {
          ...conversation,
          source: sources.length === 1 ? sources[0] : undefined,
          sources,
          messages: conversation.messages
            .filter(isChatMessage)
            .slice(-maxStoredMessages),
        };
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, maxStoredConversations);
  } catch {
    return [];
  }
}

function getInitialConversationData(): InitialConversationData {
  const storedConversations = loadStoredConversations();
  const storedActiveId = window.localStorage.getItem(
    activeConversationStorageKey,
  );
  const storedActiveConversation = storedConversations.find(
    (conversation) => conversation.id === storedActiveId,
  );

  if (storedActiveConversation) {
    return {
      conversations: storedConversations,
      activeConversationId: storedActiveConversation.id,
      activeSources: getConversationSources(storedActiveConversation),
      messages: storedActiveConversation.messages,
    };
  }

  if (storedConversations.length > 0) {
    const latestConversation = storedConversations[0];

    return {
      conversations: storedConversations,
      activeConversationId: latestConversation.id,
      activeSources: getConversationSources(latestConversation),
      messages: latestConversation.messages,
    };
  }

  let storedSources: string[] | undefined;
  const storedSourcesValue = window.localStorage.getItem(
    activeSourcesStorageKey,
  );

  if (storedSourcesValue) {
    try {
      const parsed: unknown = JSON.parse(storedSourcesValue);

      if (
        Array.isArray(parsed) &&
        parsed.every((source) => typeof source === "string")
      ) {
        storedSources = parsed;
      }
    } catch {
      storedSources = undefined;
    }
  }

  const legacySource =
    window.localStorage.getItem(activeSourceStorageKey) || undefined;
  const legacySources = normalizeSourceSelection(storedSources, legacySource);
  const legacyMessages = loadStoredMessages(legacySources[0]);
  const migratedConversation: StoredConversation = {
    id: createConversationId(),
    title: getConversationTitle(legacyMessages),
    source: legacySources.length === 1 ? legacySources[0] : undefined,
    sources: legacySources,
    messages: legacyMessages,
    updatedAt: getCurrentTimestamp(),
  };

  return {
    conversations: [migratedConversation],
    activeConversationId: migratedConversation.id,
    activeSources: legacySources,
    messages: legacyMessages,
  };
}

function BrandMark() {
  return <img aria-hidden="true" className="brand-mark-icon" src={favImage} alt="" />;
}

function AssistantIcon() {
  return (
    <img
      aria-hidden="true"
      className="assistant-avatar-icon"
      src={favImage}
      alt=""
    />
  );
}

function BrandLogo() {
  return <img className="brand-logo-image" src={logoImage} alt="MC.AI" />;
}

function DatabaseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="database-icon"
      viewBox="0 0 24 24"
      fill="none"
    >
      <ellipse
        cx="12"
        cy="5.5"
        rx="7.5"
        ry="3.25"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M4.5 5.5v6c0 1.8 3.36 3.25 7.5 3.25s7.5-1.45 7.5-3.25v-6M4.5 11.5v6c0 1.8 3.36 3.25 7.5 3.25s7.5-1.45 7.5-3.25v-6"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      className="search-icon"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle cx="10.8" cy="10.8" r="6.6" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="m16 16 4.3 4.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      aria-hidden="true"
      className="chevron-down-icon"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="m6 9 6 6 6-6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GuideIcon() {
  return (
    <svg
      aria-hidden="true"
      className="guide-icon"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="M4.5 5.75c2.2-.9 4.7-.55 7.5 1.1v12.4c-2.8-1.65-5.3-2-7.5-1.1V5.75ZM19.5 5.75c-2.2-.9-4.7-.55-7.5 1.1v12.4c2.8-1.65 5.3-2 7.5-1.1V5.75Z"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <path
        d="M12 7v12.25"
        stroke="currentColor"
        strokeWidth="1.65"
      />
    </svg>
  );
}

function CloudUploadIcon() {
  return (
    <svg
      aria-hidden="true"
      className="cloud-upload-icon"
      viewBox="0 0 32 32"
      fill="none"
    >
      <path
        d="M10.2 24.25h11.4a5.65 5.65 0 0 0 .95-11.22A7.8 7.8 0 0 0 7.2 14.8a4.75 4.75 0 0 0 3 9.45Z"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16 14.8v9m0-9-3.4 3.4m3.4-3.4 3.4 3.4"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ConversationIcon() {
  return (
    <svg
      aria-hidden="true"
      className="conversation-icon"
      viewBox="0 0 32 32"
      fill="none"
    >
      <path
        d="M8.3 22.1a8.7 8.7 0 1 1 3.15 2.25L7 26l1.3-3.9Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M11.6 15.1h.1M16 15.1h.1M20.4 15.1h.1"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function LightbulbIcon() {
  return (
    <svg
      aria-hidden="true"
      className="lightbulb-icon"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="M8.2 14.35A6.25 6.25 0 1 1 15.8 14.3c-.85.78-1.3 1.55-1.45 2.7h-4.7c-.15-1.15-.6-1.92-1.45-2.65Z"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
      <path
        d="M9.9 20.25h4.2M10.25 17h3.5M12 2V.75M4.9 4.9 4 4M19.1 4.9l.9-.9M2.75 12H1.5M22.5 12h-1.25"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DocumentOrbitIllustration() {
  return (
    <div className="empty-state-visual" aria-hidden="true">
      <span className="visual-orbit visual-orbit-outer" />
      <span className="visual-orbit visual-orbit-inner" />
      <span className="visual-star visual-star-one">✦</span>
      <span className="visual-star visual-star-two">✦</span>
      <span className="visual-star visual-star-three">✦</span>
      <span className="visual-star visual-star-four">✦</span>
      <span className="visual-star visual-star-five">✦</span>
      <span className="visual-dot visual-dot-one" />
      <span className="visual-dot visual-dot-two" />
      <span className="visual-dot visual-dot-three" />

      <span className="visual-file-chip visual-file-chip-pdf">⌁</span>
      <span className="visual-file-chip visual-file-chip-word">W</span>
      <span className="visual-file-chip visual-file-chip-text">T</span>

      <div className="visual-document-stack">
        <span className="visual-document visual-document-back" />
        <span className="visual-document visual-document-middle" />
        <span className="visual-document visual-document-front">
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  );
}

function UploadIcon() {
  return (
    <svg
      aria-hidden="true"
      className="upload-icon"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      aria-hidden="true"
      className="send-icon"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="m4 4 16 8-16 8 2.8-8L4 4Zm2.8 8H20"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg
      aria-hidden="true"
      className="menu-icon"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="M4 7h16M4 12h16M4 17h16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function LoadingSpinner({ className = "" }: { className?: string }) {
  return <span className={"loading-spinner " + className} aria-hidden="true" />;
}

function ThinkingLoader() {
  return (
    <div
      className="thinking-loader"
      role="status"
      aria-label="Assistant is thinking"
    >
      <span className="thinking-loader-orbit" aria-hidden="true">
        <span className="thinking-loader-core" />
        <span className="thinking-loader-spark thinking-loader-spark-one" />
        <span className="thinking-loader-spark thinking-loader-spark-two" />
      </span>
      <span className="thinking-loader-copy">
        <span>Thinking through your documents</span>
        <span className="thinking-loader-dots" aria-hidden="true">
          ...
        </span>
      </span>
    </div>
  );
}

function ArrowDownIcon() {
  return (
    <svg
      aria-hidden="true"
      className="arrow-down-icon"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="M12 4v15m0 0 6-6m-6 6-6-6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      aria-hidden="true"
      className="file-icon"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="M7 3.75h6.2L18 8.55v11.7H7a1.25 1.25 0 0 1-1.25-1.25V5A1.25 1.25 0 0 1 7 3.75Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M13 3.9v4.8h4.8M8.5 12h7M8.5 15h5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg
      aria-hidden="true"
      className="spark-icon"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path
        d="m12 3 1.45 5.55L19 10l-5.55 1.45L12 17l-1.45-5.55L5 10l5.55-1.45L12 3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="m19 16 .65 2.35L22 19l-2.35.65L19 22l-.65-2.35L16 19l2.35-.65L19 16Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const welcomeSteps = [
  {
      eyebrow: "1 · Add knowledge",
    title: "Start with your documents",
    description:
      "Upload one or more PDF, DOCX, or TXT files and turn them into a private, searchable workspace.",
    points: [
      "Files up to 10 MB are supported.",
      "Text is extracted and split into searchable passages.",
    ],
  },
  {
      eyebrow: "2 · Set your lens",
    title: "Choose documents to read",
    description:
      "Select one or more uploaded documents to give MC.AI a focused source for the next answer, then adjust the scope whenever your focus changes.",
    points: [
      "Compare and chat across selected documents.",
      "Your browser session only sees its own uploads.",
    ],
  },
  {
      eyebrow: "3 · Ask with intent",
    title: "Turn long files into clear answers",
    description:
      "Ask MC.AI for explanations, comparisons, requirements, summaries, or the exact details you need.",
    points: [
      "Ask follow-up questions to keep the conversation moving.",
      "Expand the source cards to inspect the supporting passages.",
    ],
  },
] as const;

type WelcomeModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onUpload: () => void;
};

function WelcomeModal({ isOpen, onClose, onUpload }: WelcomeModalProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const modalRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    const previousActiveElement = document.activeElement as HTMLElement | null;

    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }

      if (event.key === "ArrowRight") {
        setStepIndex((current) =>
          Math.min(current + 1, welcomeSteps.length - 1),
        );
      }

      if (event.key === "ArrowLeft") {
        setStepIndex((current) => Math.max(current - 1, 0));
      }

      if (event.key === "Tab") {
        const focusableElements = Array.from(
          modalRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ) ?? [],
        );

        if (focusableElements.length === 0) {
          return;
        }

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (event.shiftKey && document.activeElement === firstElement) {
          event.preventDefault();
          lastElement.focus();
        } else if (!event.shiftKey && document.activeElement === lastElement) {
          event.preventDefault();
          firstElement.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      previousActiveElement?.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  const step = welcomeSteps[stepIndex];
  const isLastStep = stepIndex === welcomeSteps.length - 1;

  return (
    <div
      className="welcome-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        ref={modalRef}
        className="welcome-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-modal-title"
        aria-describedby="welcome-modal-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          ref={closeButtonRef}
          type="button"
          className="welcome-modal-close"
          aria-label="Close welcome guide"
          onClick={onClose}
        >
          <svg
            className="welcome-close-icon"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="m6 6 12 12M18 6 6 18"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <div className="welcome-modal-grid">
          <div className="welcome-modal-hero">
            <div className="welcome-orb welcome-orb-one" />
            <div className="welcome-orb welcome-orb-two" />

            <div className="welcome-brand-lockup">
              <span className="welcome-brand-mark">
                <BrandMark />
              </span>
              <span>MC.AI</span>
            </div>

            <div className="welcome-hero-copy">
              <p className="welcome-kicker">Welcome to MC.AI</p>
              <h2 id="welcome-modal-title">Turn your documents into answers.</h2>
              <p>
                Upload once, ask naturally, and find clear answers grounded in
                the files you trust.
              </p>
            </div>

            <div className="welcome-format-list" aria-label="Supported file types">
              <span>PDF</span>
              <span>DOCX</span>
              <span>TXT</span>
            </div>

            <div className="welcome-preview" aria-hidden="true">
              <div className="welcome-preview-header">
                <span className="welcome-preview-dot" />
                <span>Document intelligence</span>
                <span className="welcome-preview-status">READY</span>
              </div>
              <div className="welcome-preview-question">
                What are the key ideas in this file?
              </div>
              <div className="welcome-preview-lines">
                <span className="welcome-preview-line is-long" />
                <span className="welcome-preview-line" />
                <span className="welcome-preview-line is-short" />
              </div>
              <div className="welcome-preview-tags">
                <span>Searchable</span>
                <span>Source-aware</span>
              </div>
            </div>

          </div>

          <div className="welcome-modal-content">
            <div className="welcome-progress-row">
              <span>
                Step {stepIndex + 1} of {welcomeSteps.length}
              </span>
              <div className="welcome-progress-track" aria-hidden="true">
                <span
                  className="welcome-progress-fill"
                  style={{
                    width: ((stepIndex + 1) / welcomeSteps.length) * 100 + "%",
                  }}
                />
              </div>
            </div>

            <p className="welcome-step-eyebrow">{step.eyebrow}</p>
            <h3>{step.title}</h3>
            <p
              className="welcome-step-description"
              id="welcome-modal-description"
            >
              {step.description}
            </p>

            <ul className="welcome-step-points">
              {step.points.map((point) => (
                <li key={point}>
                  <span aria-hidden="true">✓</span>
                  {point}
                </li>
              ))}
            </ul>

            <div className="welcome-step-nav" aria-label="Welcome guide steps">
              {welcomeSteps.map((item, index) => (
                <button
                  type="button"
                  className={
                    "welcome-step-dot" +
                    (index === stepIndex ? " is-active" : "") +
                    (index < stepIndex ? " is-complete" : "")
                  }
                  key={item.title}
                  aria-label={"Go to step " + (index + 1) + ": " + item.title}
                  aria-current={index === stepIndex ? "step" : undefined}
                  onClick={() => setStepIndex(index)}
                >
                  <span>{index + 1}</span>
                </button>
              ))}
            </div>

            <div className="welcome-modal-actions">
              <button
                type="button"
                className="welcome-skip-button"
                onClick={onClose}
              >
                Skip guide
              </button>

              <div className="welcome-navigation-actions">
                {stepIndex > 0 && (
                  <button
                    type="button"
                    className="welcome-back-button"
                    onClick={() => setStepIndex((current) => current - 1)}
                  >
                    Back
                  </button>
                )}

                <button
                  type="button"
                  className="welcome-next-button"
                  onClick={() => {
                    if (isLastStep) {
                      onUpload();
                      return;
                    }

                    setStepIndex((current) => current + 1);
                  }}
                >
                  {isLastStep ? "Upload documents" : "Next"}
                </button>
              </div>
            </div>

          </div>
        </div>
      </section>
    </div>
  );
}

type LegalDocument = "terms" | "privacy";

function TermsAndConditionsContent() {
  return (
    <div className="legal-document">
      <p className="legal-notice">
        <strong>Operator:</strong> {legalOperatorName}, Philippines. For
        questions, support, or legal notices, email{" "}
        <a href={`mailto:${legalContactEmail}`}>{legalContactEmail}</a>.
      </p>

      <section>
        <h3>1. Acceptance of these terms</h3>
        <p>
          These Terms and Conditions govern your access to and use of MC.AI,
          including its document-upload, document-search, and
          question-answering features (the “Service”). By opening, accessing, or
          using the Service, you agree to these Terms. If you do not agree, do
          not use the Service.
        </p>
        <p>
          These Terms apply together with the Privacy Policy displayed in the
          Service. If a provision of these Terms conflicts with a mandatory
          right that cannot be waived under the law that applies to you, that
          mandatory right controls only to the extent of the conflict.
        </p>
      </section>

      <section>
        <h3>2. The Service</h3>
        <p>
          The Service lets you upload PDF, DOCX, and TXT files, convert their
          text into searchable passages and embeddings, ask questions about the
          indexed content, and review answers with supporting source excerpts.
          The Service is provided for information and productivity purposes.
          Features, file limits, supported formats, models, and availability may
          change over time.
        </p>
        <p>
          The Service does not create an account profile or require a sign-in in
          its current form. A browser session identifier is used to separate one
          visitor's indexed documents from another visitor's documents. This
          session design is described in more detail in the Privacy Policy.
        </p>
      </section>

      <section>
        <h3>3. Eligibility and authority</h3>
        <p>
          You may use the Service only if you can legally agree to these Terms
          and are not prohibited from using the Service under applicable law. If
          you use the Service for an organization, you represent that you have
          authority to accept these Terms on that organization’s behalf. The
          Service is not directed to children below the minimum age required
          where they live; do not use it to submit a child’s personal
          information without the required authorization.
        </p>
      </section>

      <section>
        <h3>4. Your documents and content</h3>
        <p>
          You retain the ownership rights you already have in files, text,
          questions, and other material that you submit (“Your Content”). You
          are responsible for Your Content and for making sure you have all
          permissions, licenses, notices, and consents needed to upload it and
          have it processed by the Service.
        </p>
        <p>
          You grant the Service operator a limited, non-exclusive, worldwide,
          royalty-free license to host, copy, extract, transform, index,
          retrieve, transmit, and process Your Content only as needed to
          operate, secure, maintain, troubleshoot, and improve the Service and
          to provide requested answers. This license ends when the relevant
          Content is deleted, except for limited copies that must be retained
          for security, legal, backup, or dispute-resolution reasons.
        </p>
        <p>
          Do not upload information that you are not authorized to disclose or
          process. Unless the operator has expressly agreed otherwise in
          writing, do not use the Service as the sole repository for originals
          or as a regulated records-management system.
        </p>
      </section>

      <section>
        <h3>5. Acceptable use</h3>
        <p>You agree not to:</p>
        <ul>
          <li>
            upload malware, malicious code, unlawful material, or content that
            infringes another person’s rights;
          </li>
          <li>
            use the Service to violate privacy, confidentiality, copyright,
            trade-secret, export-control, or other legal obligations;
          </li>
          <li>
            attempt to access, search, alter, delete, or disclose another
            visitor’s documents, session, or generated answers;
          </li>
          <li>
            probe, scan, reverse engineer, overload, interfere with, or bypass
            authentication, access controls, rate limits, or security features;
          </li>
          <li>
            use automated requests or scraping that place an unreasonable load
            on the Service or its providers; or
          </li>
          <li>
            use the Service for fraud, harassment, discrimination, harmful
            decisions, or any activity that could cause injury or damage.
          </li>
        </ul>
        <p>
          You must promptly report suspected unauthorized access, accidental
          disclosure, or security problems to the Service operator through the
          support contact provided for your deployment.
        </p>
      </section>

      <section>
        <h3>6. AI-generated answers</h3>
        <p>
          Answers are generated by automated models using retrieved passages
          and, where applicable, the recent conversation provided with your
          question. AI output can be incomplete, outdated, incorrect, or
          misleading, and source excerpts may not include every relevant part of
          a document. You must independently verify important information
          against the original document and use professional judgment.
        </p>
        <p>
          The Service is not legal, medical, financial, employment, safety,
          engineering, or other professional advice. Do not rely on an answer as
          the sole basis for a decision that could affect a person’s rights,
          safety, health, finances, employment, education, or access to a
          service. Do not treat generated text as a statement by the Service
          operator or as a guarantee of any outcome.
        </p>
      </section>

      <section>
        <h3>7. Privacy and visitor isolation</h3>
        <p>
          The Privacy Policy explains what information the Service processes,
          why it is processed, which providers may receive it, and how you can
          request deletion or exercise other rights. By using the Service, you
          acknowledge that uploaded content and questions must be transmitted to
          the infrastructure and AI providers needed to return an answer.
        </p>
        <p>
          The application uses a server-issued visitor identifier and applies
          that identifier when listing, searching, and deleting indexed
          documents. This is an application control, not a promise of absolute
          security. Do not upload highly sensitive or regulated information
          unless you have assessed the risks and the operator has approved the
          use case.
        </p>
      </section>

      <section>
        <h3>8. Ownership of the Service</h3>
        <p>
          The Service, including its software, interface, design, branding,
          documentation, and original materials, is owned by or licensed to the
          Service operator and is protected by applicable intellectual property
          laws. Except for the limited right to use the Service under these
          Terms, no ownership right is transferred to you.
        </p>
        <p>
          You may send suggestions or feedback. You grant the operator the right
          to use feedback without restriction or payment, provided that the
          operator does not publicly identify you as the source without
          permission.
        </p>
      </section>

      <section>
        <h3>9. Third-party services</h3>
        <p>
          The Service depends on third-party infrastructure and model providers,
          which may include Google AI services for embeddings and generated
          answers, DataStax Astra DB for indexed document storage, and hosting,
          networking, monitoring, or security providers. Those providers may
          have their own terms, privacy policies, availability limits, and
          data-processing practices. You authorize the operator to use those
          providers as reasonably necessary to provide the Service.
        </p>
        <p>
          The operator is not responsible for the independent acts, omissions,
          outages, or policies of third-party services. A change or failure in a
          third-party service may affect the Service without creating a breach
          of these Terms.
        </p>
      </section>

      <section>
        <h3>10. Availability, changes, and support</h3>
        <p>
          The Service may be unavailable, delayed, rate-limited, or changed for
          maintenance, security, capacity, provider, or operational reasons. The
          operator does not promise uninterrupted availability, a specific
          response time, a particular model, or preservation of any feature or
          stored Content. You are responsible for keeping independent copies of
          important documents and answers.
        </p>
        <p>
          The operator may add, remove, or modify features and may update these
          Terms. If a change materially affects your rights or obligations,
          MCANGHEL will provide notice appropriate to the deployment.
          Continuing to use the Service after the effective date of an update
          means you accept the updated Terms, to the extent permitted by law.
        </p>
      </section>

      <section>
        <h3>11. Deletion, suspension, and termination</h3>
        <p>
          You can delete an indexed document from the knowledge panel. Deleting
          a document removes the indexed chunks associated with that source for
          your visitor session, but it may not immediately remove transient
          processing data, logs, backups, or copies retained where required by
          law or legitimate security needs.
        </p>
        <p>
          Indexed documents are also removed automatically when this page
          session ends. The page sends a short heartbeat while it is open and
          schedules cleanup when it closes; a brief grace period allows a normal
          refresh to reconnect without losing documents. Cleanup remains best
          effort because a browser, device shutdown, network failure, or API
          restart may stop the signal or timer before it completes.
        </p>
        <p>
          The operator may suspend or terminate access if it reasonably believes
          the Service is being misused, security is at risk, a legal requirement
          applies, or continued operation is not practical. On termination, your
          right to use the Service ends, and provisions that by their nature
          should survive will continue to apply.
        </p>
      </section>

      <section>
        <h3>12. Disclaimers</h3>
        <p>
          To the maximum extent allowed by law, the Service is provided “as is”
          and “as available,” without warranties of any kind, express or
          implied. The operator disclaims warranties of accuracy, completeness,
          fitness for a particular purpose, merchantability, non-infringement,
          availability, security, and that the Service or its answers will meet
          your requirements or be error-free.
        </p>
        <p>
          Nothing in these Terms excludes a warranty or right that applicable
          law does not allow the operator to exclude.
        </p>
      </section>

      <section>
        <h3>13. Limitation of liability</h3>
        <p>
          To the maximum extent allowed by law, the operator and its officers,
          employees, contractors, licensors, and service providers will not be
          liable for indirect, incidental, special, consequential, exemplary, or
          punitive loss, or for loss of data, profits, revenue, goodwill,
          business opportunity, or expected savings arising from or related to
          the Service.
        </p>
        <p>
          To the maximum extent allowed by law, the total liability for claims
          related to the Service will not exceed the amount you paid to use the
          Service during the twelve months before the event giving rise to the
          claim, or 100 USD if you used the Service without payment. These
          limits do not apply where the law prohibits them or to liability that
          cannot legally be limited.
        </p>
      </section>

      <section>
        <h3>14. Indemnity</h3>
        <p>
          To the extent permitted by law, you agree to defend and indemnify the
          operator and its affiliates, personnel, licensors, and providers
          against claims, losses, liabilities, costs, and expenses arising from
          Your Content, your breach of these Terms, your unlawful use of the
          Service, or your violation of another person’s rights. The operator
          will provide reasonable notice of a claim and may participate in its
          defense. This section does not require indemnification to the extent
          caused by the operator’s own willful misconduct or liability that
          cannot legally be shifted.
        </p>
      </section>

      <section>
        <h3>15. Governing law and disputes</h3>
        <p>
          These Terms are governed by the laws of the Republic of the
          Philippines, without regard to conflict-of-law rules. Subject to
          mandatory consumer protections and any required alternative dispute
          process, disputes relating to the Service will be brought before a
          court of competent jurisdiction in the Philippines. Before starting a
          formal proceeding, please contact MCANGHEL at{" "}
          <a href={`mailto:${legalContactEmail}`}>{legalContactEmail}</a> so we
          can try to resolve the issue informally.
        </p>
      </section>

      <section>
        <h3>16. General terms and contact</h3>
        <p>
          If a court finds part of these Terms unenforceable, the remaining
          provisions remain effective. A failure to enforce a provision is not a
          waiver. You may not transfer your rights under these Terms without the
          operator’s written consent; the operator may transfer its rights as
          part of a reorganization, sale, or transfer of the Service.
        </p>
        <p>
          MCANGHEL operates MC.AI from the Philippines. For questions, legal
          notices, privacy requests, or support, contact{" "}
          <a href={`mailto:${legalContactEmail}`}>{legalContactEmail}</a>.
          Include enough information to identify the relevant browser session or
          request without sending sensitive document content unnecessarily.
        </p>
      </section>
    </div>
  );
}

function PrivacyPolicyContent() {
  return (
    <div className="legal-document">
      <p className="legal-notice">
        <strong>Operator:</strong> {legalOperatorName}, Philippines. For
        privacy questions, rights requests, or security concerns, email{" "}
        <a href={`mailto:${legalContactEmail}`}>{legalContactEmail}</a>.
      </p>

      <section>
        <h3>1. Who this policy is for</h3>
        <p>
          This Privacy Policy explains how the operator of MC.AI (the
          “Service”) collects, uses, stores, shares, and protects information
          when you visit or use the document-upload and question-answering
          workspace. In this policy, “we,” “us,” and “our” mean MCANGHEL, the
          operator of this deployment in the Philippines. You can contact us at{" "}
          <a href={`mailto:${legalContactEmail}`}>{legalContactEmail}</a>.
        </p>
        <p>
          This policy describes the current application behavior. If the
          deployment adds accounts, analytics, advertising, payments, team
          sharing, or other features, the operator must update this policy
          before collecting the related information.
        </p>
      </section>

      <section>
        <h3>2. Information we process</h3>
        <p>Depending on how you use the Service, we may process:</p>
        <ul>
          <li>
            <strong>Uploaded content:</strong> the original filename, file type,
            extracted text, document passages, page or location metadata, and
            searchable vector embeddings created from supported PDF, DOCX, or
            TXT files;
          </li>
          <li>
            <strong>Questions and conversation context:</strong> the questions
            you submit, the recent chat history sent with a follow-up question,
            generated answers, and source excerpts returned to the interface;
          </li>
          <li>
            <strong>Browser storage:</strong> conversation history, the active
            document selection, and guide-dismissal preference stored in your
            browser’s local storage by the frontend;
          </li>
          <li>
            <strong>Session and security data:</strong> an anonymous visitor
            identifier and a CSRF security token stored in necessary cookies;
            and
          </li>
          <li>
            <strong>Technical information:</strong> information normally
            available to the hosting, networking, and security systems that
            receive a request, such as IP address, browser type, timestamps,
            request paths, status codes, and diagnostic data, if those systems
            log it.
          </li>
        </ul>
        <p>
          We do not ask you to provide your name, account password, precise
          location, contacts, or payment information in the current interface.
          Do not put those details, or sensitive personal information about
          another person, into an uploaded document or question unless you are
          authorized and the use is appropriate for the deployment.
        </p>
      </section>

      <section>
        <h3>3. How the Service works</h3>
        <p>
          When you upload a file, the server checks its format and size,
          extracts readable text, splits the text into searchable passages,
          creates embeddings, and stores the passages and embeddings in the
          configured vector database. When you ask a question, the Service
          searches the documents associated with your visitor session and sends
          relevant context and your question to the configured AI model to
          generate an answer.
        </p>
        <p>
          The current application uses a server-issued random visitor ID in an
          HttpOnly cookie. The ID is stored with indexed chunks as an ownership
          marker, and server-side list, search, retrieve, and delete operations
          are filtered by that marker. This is intended to prevent visitors from
          accessing one another’s uploaded documents. It is still important not
          to upload information that requires a stronger contractual or
          regulatory control than this deployment provides.
        </p>
      </section>

      <section>
        <h3>4. Why we use information</h3>
        <p>We may use information to:</p>
        <ul>
          <li>
            provide document upload, indexing, search, and answer features;
          </li>
          <li>
            keep each anonymous browser session scoped to its own documents;
          </li>
          <li>maintain conversation continuity in your browser;</li>
          <li>authenticate state-changing requests and prevent abuse;</li>
          <li>
            diagnose errors, maintain availability, and improve reliability;
          </li>
          <li>
            protect the Service, users, providers, and the public from misuse;
          </li>
          <li>
            comply with legal obligations and respond to lawful requests; and
          </li>
          <li>enforce the Terms and investigate suspected violations.</li>
        </ul>
        <p>
          Where Philippine law applies, we process personal information only
          when permitted by law. Depending on the purpose, the applicable basis
          may include your consent, steps requested before or performance of an
          agreement, compliance with a legal obligation, protection of lawful
          rights and interests, or another lawful basis recognized by the
          Philippines Data Privacy Act and its implementing rules. We apply the
          principles of transparency, legitimate purpose, and proportionality.
        </p>
      </section>

      <section>
        <h3>5. Cookies and browser storage</h3>
        <p>
          The backend sets a necessary <code>rag_visitor</code> cookie to
          identify your anonymous browser session and a necessary
          <code>rag_csrf</code> cookie to protect upload, delete, and question
          requests from cross-site request forgery. In the current configuration
          these cookies are HttpOnly, use the site path, use SameSite
          protection, and are configured to last for up to 30 days. Production
          deployments should use Secure cookies over HTTPS.
        </p>
        <p>
          The frontend also uses local storage for conversation messages, active
          conversation and document selection, and whether the welcome guide has
          been dismissed. This information stays in the browser until the user
          or browser removes it, or the application changes its storage
          behavior. Indexed documents are removed after the page session closes
          and its heartbeat lease expires; conversation history remains
          browser-local unless it is cleared from browser storage.
        </p>
        <p>
          The current interface does not intentionally use advertising cookies
          or third-party analytics cookies. Review the deployment if additional
          scripts, analytics, consent tools, or embedded content are added.
        </p>
      </section>

      <section>
        <h3>6. Who may receive information</h3>
        <p>
          We may disclose information to service providers that process it on
          our behalf, including:
        </p>
        <ul>
          <li>
            <strong>Google AI services:</strong> uploaded text, document
            context, questions, and related history may be sent to the
            configured Google model for embeddings and answer generation;
          </li>
          <li>
            <strong>DataStax Astra DB:</strong> extracted passages, metadata,
            ownership markers, and vector embeddings may be stored in the
            configured database; and
          </li>
          <li>
            <strong>Hosting and operations providers:</strong> requests,
            technical information, and diagnostic data may be processed by the
            infrastructure used to host, secure, monitor, and deliver the
            Service.
          </li>
          <li>
            <strong>Font delivery:</strong> the browser may request the Space
            Grotesk and DM Mono font files from the configured font CDN. That
            request can include normal technical connection information, but
            uploaded documents and questions are not sent as part of the font
            request.
          </li>
        </ul>
        <p>
          We may also disclose information when required by law, subpoena, court
          order, or government request; to investigate security or abuse; to
          protect rights, safety, or property; or as part of a merger,
          financing, reorganization, sale, or transfer of the Service. We do not
          intend to sell uploaded documents or use them for targeted advertising
          in the current application.
        </p>
        <p>
          Third-party providers may process information under their own terms
          and privacy policies. Before uploading confidential or regulated
          content, review the risks and the applicable provider terms. MCANGHEL
          does not intentionally sell uploaded documents or use them for
          targeted advertising.
        </p>
      </section>

      <section>
        <h3>7. Retention and deletion</h3>
        <p>
          Indexed document passages and embeddings remain available to the
          associated visitor session until you delete the source through the
          knowledge panel or the page session ends. When the page session ends,
          the frontend sends a keepalive close signal. If the page does not
          reconnect during the short close grace period, or if its heartbeat
          lease later expires, the server removes every indexed chunk owned by
          that visitor. A successful delete request removes the matching
          indexed chunks, subject to transient processing, backups, logs, and
          other copies that cannot be removed immediately.
        </p>
        <p>
          Conversation messages and selections stored in local storage remain in
          your browser until you clear them or the browser removes them. Server
          and provider logs may be retained for the period needed for security,
          troubleshooting, legal compliance, and service operations, and are
          deleted or anonymized when they are no longer reasonably needed. We do
          not keep a separate permanent copy of your document in the frontend’s
          browser storage.
        </p>
        <p>
          To request deletion of server-side data, email{" "}
          <a href={`mailto:${legalContactEmail}`}>{legalContactEmail}</a> and
          include the relevant filename and browser-session details without
          emailing the document itself unless necessary. If the visitor cookie
          has been cleared, we may be unable to match a request to the original
          anonymous session without additional verification.
        </p>
      </section>

      <section>
        <h3>8. International processing</h3>
        <p>
          MCANGHEL and its providers may process information in countries
          different from the country where you live, including where the
          Service’s hosting, database, AI, or delivery providers operate. Where
          Philippine law or another applicable law requires safeguards for an
          international transfer, we will apply the safeguards required by that
          law. Contact{" "}
          <a href={`mailto:${legalContactEmail}`}>{legalContactEmail}</a> for
          questions about international processing.
        </p>
      </section>

      <section>
        <h3>9. Security</h3>
        <p>
          We use reasonable technical and organizational measures for the
          deployment, including HTTPS in production, HttpOnly security cookies,
          CSRF protection for state-changing requests, server-side visitor
          filtering, input validation, file-type and size checks, and provider
          access controls. No internet transmission, storage system, or AI
          service is completely secure, so we cannot guarantee absolute
          security.
        </p>
        <p>
          If you believe your content or session has been accessed without
          authorization, notify MCANGHEL promptly at{" "}
          <a href={`mailto:${legalContactEmail}`}>{legalContactEmail}</a>. We
          may investigate and notify affected people or authorities when
          required by law.
        </p>
      </section>

      <section>
        <h3>10. Your privacy rights</h3>
        <p>
          Subject to the conditions and exceptions in applicable law, including
          the Philippines Data Privacy Act, you may have the right to be
          informed, access your personal information, correct inaccurate
          information, object to certain processing, request erasure or
          blocking, request data portability, and seek damages or file a
          complaint with the National Privacy Commission. Other rights may
          apply depending on where you live.
        </p>
        <p>
          Send a request to{" "}
          <a href={`mailto:${legalContactEmail}`}>{legalContactEmail}</a>. We
          may ask for information needed to verify the request and protect
          another person’s data. Because the current Service uses anonymous
          sessions, we may not be able to identify or provide data if there is
          not enough information to connect the request to a session. We will
          respond within the period required by applicable law.
        </p>
        <p>
          If another privacy law applies to you, you may also contact the
          relevant data-protection authority in your country or place of work.
        </p>
      </section>

      <section>
        <h3>11. Children’s information</h3>
        <p>
          The Service is not intended for children below the minimum age
          required by applicable law. We do not knowingly request children’s
          personal information. If you believe a child submitted personal
          information, contact the operator so it can investigate and delete it
          where appropriate.
        </p>
      </section>

      <section>
        <h3>12. Automated processing</h3>
        <p>
          The Service uses automated retrieval, embedding, and language-model
          processing to return answers. It is not intended to make decisions
          about a person’s legal rights, eligibility, employment, credit,
          housing, education, insurance, health, or access to essential
          services. MCANGHEL does not use the current Service to make those
          decisions, and generated answers require independent human review.
        </p>
      </section>

      <section>
        <h3>13. Changes and contact</h3>
        <p>
          We may update this Privacy Policy when the Service, providers, legal
          requirements, or information practices change. We will update the
          effective date and provide additional notice when required. Please
          review the policy periodically.
        </p>
        <p>
          For privacy questions, rights requests, security concerns, or legal
          notices, contact MCANGHEL at{" "}
          <a href={`mailto:${legalContactEmail}`}>{legalContactEmail}</a>.
          MCANGHEL is based in the Philippines and will update this policy when
          the Service or its information practices change.
        </p>
      </section>
    </div>
  );
}

function LegalModal({
  legalDocument,
  onClose,
}: {
  legalDocument: LegalDocument | null;
  onClose: () => void;
}) {
  const modalRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!legalDocument) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    const previousActiveElement = document.activeElement as HTMLElement | null;

    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );

      if (focusableElements.length === 0) {
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      previousActiveElement?.focus();
    };
  }, [legalDocument, onClose]);

  if (!legalDocument) {
    return null;
  }

  const isTerms = legalDocument === "terms";
  const title = isTerms ? "Terms & Conditions" : "Privacy Policy";
  const titleId = isTerms ? "terms-modal-title" : "privacy-modal-title";

  return (
    <div
      className="legal-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        ref={modalRef}
        className="legal-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="legal-modal-header">
          <div>
            <p className="eyebrow">Legal</p>
            <h2 id={titleId}>{title}</h2>
            <p className="legal-modal-meta">
              Effective date: {legalEffectiveDate}
            </p>
          </div>

          <button
            ref={closeButtonRef}
            type="button"
            className="legal-modal-close"
            aria-label={"Close " + title}
            onClick={onClose}
          >
            <svg
              className="legal-close-icon"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="m6 6 12 12M18 6 6 18"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div className="legal-modal-body">
          {isTerms ? <TermsAndConditionsContent /> : <PrivacyPolicyContent />}
        </div>

        <footer className="legal-modal-footer">
          <p>
            Questions? Email{" "}
            <a href={`mailto:${legalContactEmail}`}>{legalContactEmail}</a>.
          </p>
          <button type="button" className="legal-modal-done" onClick={onClose}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}

type RemoveConfirmationModalProps = {
  sources: string[];
  isRemoving: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

function RemoveConfirmationModal({
  sources,
  isRemoving,
  error,
  onCancel,
  onConfirm,
}: RemoveConfirmationModalProps) {
  const modalRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!sources.length) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    const previousActiveElement = document.activeElement as HTMLElement | null;

    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();

        if (!isRemoving) {
          onCancel();
        }

        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );

      if (focusableElements.length === 0) {
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      previousActiveElement?.focus();
    };
  }, [isRemoving, onCancel, sources]);

  if (!sources.length) {
    return null;
  }

  return (
    <div
      className="remove-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isRemoving) {
          onCancel();
        }
      }}
    >
      <section
        ref={modalRef}
        className="remove-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-modal-title"
        aria-describedby="remove-modal-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="remove-modal-header">
          <div className="remove-modal-heading">
            <span className="remove-modal-icon" aria-hidden="true">
              !
            </span>
            <div>
              <p className="eyebrow">
                {sources.length > 1 ? "Remove documents" : "Remove document"}
              </p>
              <h2 id="remove-modal-title">
                {sources.length > 1
                  ? "Remove selected documents?"
                  : "Remove this document?"}
              </h2>
            </div>
          </div>

          <button
            ref={closeButtonRef}
            type="button"
            className="remove-modal-close"
            aria-label="Close remove document dialog"
            onClick={onCancel}
            disabled={isRemoving}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="m6 6 12 12M18 6 6 18"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div className="remove-modal-body">
          {sources.length === 1 ? (
            <p id="remove-modal-description">
              Remove <strong title={sources[0]}>{sources[0]}</strong> from your
              knowledge base? Its indexed content will be removed and cannot
              be recovered.
            </p>
          ) : (
            <>
              <p id="remove-modal-description">
                Remove these documents from your knowledge base? Their indexed
                content will be removed and cannot be recovered.
              </p>
              <ul className="remove-modal-source-list" aria-label="Selected documents">
                {sources.map((source, index) => (
                  <li key={source + "-" + index} title={source}>
                    {source}
                  </li>
                ))}
              </ul>
              <p className="remove-modal-warning">
                This action applies to every selected document.
              </p>
            </>
          )}

          {error && (
            <p className="remove-modal-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="remove-modal-footer">
          <button
            type="button"
            className="remove-modal-cancel"
            onClick={onCancel}
            disabled={isRemoving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="remove-modal-confirm"
            onClick={onConfirm}
            disabled={isRemoving}
          >
            {isRemoving ? (
              <>
                <LoadingSpinner className="remove-modal-spinner" />
                Removing{sources.length > 1 ? " documents" : ""}...
              </>
            ) : (
              sources.length > 1 ? "Remove documents" : "Remove document"
            )}
          </button>
        </footer>
      </section>
    </div>
  );
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) {
    return bytes + " B";
  }

  const kilobytes = bytes / 1024;

  if (kilobytes < 1024) {
    return kilobytes.toFixed(1) + " KB";
  }

  return (kilobytes / 1024).toFixed(1) + " MB";
}

function App() {
  const [question, setQuestion] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(
    null,
  );
  const [initialConversationData] = useState<InitialConversationData>(() =>
    getInitialConversationData(),
  );
  const [conversations, setConversations] = useState<StoredConversation[]>(
    () => initialConversationData.conversations,
  );
  const [activeConversationId, setActiveConversationId] = useState<string>(
    () => initialConversationData.activeConversationId,
  );
  const [activeSources, setActiveSources] = useState<string[]>(
    () => initialConversationData.activeSources,
  );
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => initialConversationData.messages,
  );
  const [streamingAnswer, setStreamingAnswer] = useState<string | null>(null);
  const [isKnowledgePanelOpen, setIsKnowledgePanelOpen] = useState(false);
  const [isMobileScopeOpen, setIsMobileScopeOpen] = useState(false);
  const [isWelcomeOpen, setIsWelcomeOpen] = useState(
    () => window.localStorage.getItem(welcomeModalStorageKey) !== "true",
  );
  const [removeConfirmationSources, setRemoveConfirmationSources] = useState<
    string[]
  >([]);
  const [activeLegalDocument, setActiveLegalDocument] =
    useState<LegalDocument | null>(null);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [generationStatus, setGenerationStatus] =
    useState<GenerationStatus>("idle");
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(
    null,
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const questionInputRef = useRef<HTMLTextAreaElement>(null);
  const chatContentRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const streamAbortControllerRef = useRef<AbortController | null>(null);
  const generationStatusRef = useRef<GenerationStatus>("idle");
  const nextGenerationIdRef = useRef(0);
  const activeGenerationIdRef = useRef<number | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    const handlePageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) {
        scheduleSessionCloseOnPageExit();
      }
    };
    const sendHeartbeat = () => {
      void touchSession().catch(() => {
        // The next heartbeat retries while the page remains open.
      });
    };

    window.addEventListener('pagehide', handlePageHide);
    sendHeartbeat();
    const heartbeatTimer = window.setInterval(
      sendHeartbeat,
      sessionHeartbeatIntervalMs,
    );

    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      window.clearInterval(heartbeatTimer);
    };
  }, []);

  const closeWelcomeModal = useCallback(() => {
    window.localStorage.setItem(welcomeModalStorageKey, "true");
    setIsWelcomeOpen(false);
  }, []);

  const closeLegalModal = useCallback(() => {
    setActiveLegalDocument(null);
  }, []);

  function updateGenerationStatus(status: GenerationStatus) {
    generationStatusRef.current = status;
    setGenerationStatus(status);
  }

  function finishGeneration(generationId: number) {
    if (activeGenerationIdRef.current !== generationId) {
      return;
    }

    activeGenerationIdRef.current = null;
    updateGenerationStatus("idle");
  }

  const sourcesQuery = useQuery({
    queryKey: ["document-sources"],
    queryFn: listSources,
    refetchOnMount: "always",
  });

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.status === "degraded" ? 10_000 : false,
  });

  const askMutation = useMutation({
    mutationFn: async ({
      input,
      generationId,
    }: AskMutationInput): Promise<AskMutationResult> => {
      let answer = "";
      let sources: RagSource[] = [];
      const controller = new AbortController();

      if (
        generationStatusRef.current !== "running" ||
        activeGenerationIdRef.current !== generationId
      ) {
        controller.abort();

        return { answer: "", sources: [], cancelled: true, generationId };
      }

      streamAbortControllerRef.current = controller;

      try {
        await askQuestionStream(
          input,
          (event) => {
            if (
              controller.signal.aborted ||
              generationStatusRef.current !== "running" ||
              activeGenerationIdRef.current !== generationId
            ) {
              return;
            }

            if (event.type === "token") {
              answer += event.token;
              setStreamingAnswer(answer);
            } else if (event.type === "sources") {
              sources = event.sources;
            }
          },
          controller.signal,
        );

        if (
          controller.signal.aborted ||
          generationStatusRef.current !== "running" ||
          activeGenerationIdRef.current !== generationId
        ) {
          return { answer: "", sources: [], cancelled: true, generationId };
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          throw error;
        }

        return { answer: "", sources: [], cancelled: true, generationId };
      } finally {
        if (streamAbortControllerRef.current === controller) {
          streamAbortControllerRef.current = null;
        }
      }

      return { answer, sources, cancelled: false, generationId };
    },
  });

  const uploadMutation = useMutation<UploadBatchResult, Error, File[]>({
    mutationFn: async (files) => {
      const successes: UploadResponse[] = [];
      const failures: UploadBatchFailure[] = [];

      for (const [index, file] of files.entries()) {
        try {
          const result = await uploadDocument(file, (percent) => {
            setUploadProgress({
              currentFile: index + 1,
              totalFiles: files.length,
              percent,
            });
          });

          successes.push(result);
        } catch (error) {
          failures.push({
            filename: file.name,
            message: getApiErrorMessage(error),
            isTransient: isTransientApiError(error),
          });
        }
      }

      return { successes, failures };
    },
  });

  const deleteMutation = useMutation<DeleteBatchResult, Error, string[]>({
    mutationFn: async (sources) => {
      const results = await Promise.allSettled(
        sources.map((source) => deleteDocument(source)),
      );
      const successes: DeleteSourceResponse[] = [];
      const failures: DeleteBatchFailure[] = [];

      results.forEach((result, index) => {
        const source = sources[index] ?? "Unknown document";

        if (result.status === "fulfilled") {
          successes.push(result.value);
        } else {
          failures.push({
            source,
            message: getApiErrorMessage(result.reason),
          });
        }
      });

      return { successes, failures };
    },
  });

  const selectedSources = sourcesQuery.isFetching
    ? []
    : (() => {
        const availableSources = sourcesQuery.data ?? [];
        const validSources = activeSources.filter((source) =>
          availableSources.includes(source),
        );

        return validSources;
      })();
  const visibleMessages = messages;
  const documentCount = sourcesQuery.data?.length ?? 0;
  const connectionIsDegraded =
    sourcesQuery.isError ||
    healthQuery.isError ||
    healthQuery.data?.status === "degraded";

  useEffect(() => {
    window.localStorage.setItem(
      activeConversationStorageKey,
      activeConversationId,
    );

    if (activeSources.length > 0) {
      window.localStorage.setItem(
        activeSourcesStorageKey,
        JSON.stringify(activeSources),
      );
      window.localStorage.setItem(activeSourceStorageKey, activeSources[0]);
    } else {
      window.localStorage.removeItem(activeSourcesStorageKey);
      window.localStorage.removeItem(activeSourceStorageKey);
    }
  }, [activeConversationId, activeSources]);

  useEffect(() => {
    window.localStorage.setItem(
      conversationsStorageKey,
      JSON.stringify(conversations),
    );
  }, [conversations]);

  useEffect(() => {
    if (visibleMessages.length === 0) {
      chatContentRef.current?.scrollTo({ top: 0, behavior: "auto" });
      return;
    }

    if (isNearBottomRef.current) {
      chatContentRef.current?.scrollTo({
        top: chatContentRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [generationStatus, streamingAnswer?.length, visibleMessages.length]);

  function handleChatScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    const isNearBottom = distanceFromBottom < 96;

    isNearBottomRef.current = isNearBottom;
    setShowScrollToLatest(!isNearBottom);
  }

  function scrollToLatest() {
    isNearBottomRef.current = true;
    setShowScrollToLatest(false);
    chatContentRef.current?.scrollTo({
      top: chatContentRef.current.scrollHeight,
      behavior: "smooth",
    });
  }

  function syncActiveConversation(
    nextMessages: ChatMessage[],
    nextSources = selectedSources,
  ) {
    const updatedAt = getCurrentTimestamp();

    setConversations((current) =>
      updateStoredConversation(
        current,
        activeConversationId,
        nextMessages,
        nextSources,
        updatedAt,
      ),
    );
  }

  function stopStreamingResponse() {
    if (generationStatusRef.current !== "running") {
      return;
    }

    updateGenerationStatus("stopping");
    streamAbortControllerRef.current?.abort();
    setStreamingAnswer(null);
    const nextMessages = removePendingAssistant(messages);
    setMessages(nextMessages);
    syncActiveConversation(nextMessages);
  }

  function abandonCurrentGeneration() {
    activeGenerationIdRef.current = null;
    streamAbortControllerRef.current?.abort();
    streamAbortControllerRef.current = null;
    updateGenerationStatus("idle");
    setStreamingAnswer(null);
    const nextMessages = removePendingAssistant(messages);

    if (nextMessages !== messages) {
      setMessages(nextMessages);
      syncActiveConversation(nextMessages);
    }
  }

  function startNewConversation() {
    abandonCurrentGeneration();

    const conversation = createEmptyConversation(selectedSources);

    setConversations((current) =>
      [conversation, ...current].slice(0, maxStoredConversations),
    );
    setActiveConversationId(conversation.id);
    setMessages([]);
    setQuestion("");
    setStreamingAnswer(null);
    setCopiedMessageIndex(null);
    setShowScrollToLatest(false);
    isNearBottomRef.current = true;
    askMutation.reset();
    deleteMutation.reset();
  }

  function handleStopClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    stopStreamingResponse();
  }

  async function handleCopyAnswer(content: string, messageIndex: number) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageIndex(messageIndex);

      window.setTimeout(() => {
        setCopiedMessageIndex((current) =>
          current === messageIndex ? null : current,
        );
      }, 1800);
    } catch {
      setCopiedMessageIndex(null);
    }
  }

  function handleFilesSelected(files: FileList | File[]) {
    const incomingFiles = Array.from(files);

    // Keep the mobile knowledge drawer visible after the native file picker returns.
    setIsMobileScopeOpen(false);
    setIsKnowledgePanelOpen(true);

    if (!incomingFiles.length) {
      return;
    }

    const selectedNames = new Set(
      selectedFiles.map((file) => file.name.toLowerCase()),
    );
    const acceptedFiles: File[] = [];
    const errors: string[] = [];

    for (const file of incomingFiles) {
      const lowerName = file.name.toLowerCase();
      const isPdf =
        file.type === "application/pdf" || lowerName.endsWith(".pdf");
      const isText = file.type === "text/plain" || lowerName.endsWith(".txt");
      const isDocx =
        file.type ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        lowerName.endsWith(".docx");

      if (file.size > maxDocumentSizeBytes) {
        errors.push(file.name + ": files must be 10 MB or smaller.");
        continue;
      }

      if (!isPdf && !isText && !isDocx) {
        errors.push(file.name + ": choose a PDF, DOCX, or TXT file.");
        continue;
      }

      if (selectedNames.has(lowerName)) {
        errors.push(file.name + ": already selected.");
        continue;
      }

      selectedNames.add(lowerName);
      acceptedFiles.push(file);
    }

    if (acceptedFiles.length) {
      setSelectedFiles((current) => [...current, ...acceptedFiles]);
      setUploadProgress(null);
      uploadMutation.reset();
    }

    setFileError(errors.length ? errors.join(" ") : null);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleWelcomeUpload() {
    closeWelcomeModal();
    setIsMobileScopeOpen(false);
    setIsKnowledgePanelOpen(true);
    fileInputRef.current?.click();
  }

  function toggleKnowledgePanel() {
    if (!isKnowledgePanelOpen) {
      setIsMobileScopeOpen(false);
    }

    setIsKnowledgePanelOpen((isOpen) => !isOpen);
  }

  function handleSourceChange(nextSource: string) {
    const isSelected = selectedSources.includes(nextSource);

    const nextSources = isSelected
      ? selectedSources.filter((source) => source !== nextSource)
      : [...selectedSources, nextSource];

    abandonCurrentGeneration();
    setActiveSources(nextSources);
    setMessages([]);
    syncActiveConversation([], nextSources);
    setCopiedMessageIndex(null);
    askMutation.reset();
    deleteMutation.reset();
  }

  function removeSelectedFile(index: number) {
    if (uploadMutation.isPending) {
      return;
    }

    setSelectedFiles((current) =>
      current.filter((_, fileIndex) => fileIndex !== index),
    );
    setFileError(null);
    setUploadProgress(null);
    uploadMutation.reset();

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleFileDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDragging(false);
    handleFilesSelected(event.dataTransfer.files);
  }

  function handleFileSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedFiles.length || uploadMutation.isPending) {
      return;
    }

    setFileError(null);
    setUploadProgress({
      currentFile: 1,
      totalFiles: selectedFiles.length,
      percent: 0,
    });
    uploadMutation.reset();
    uploadMutation.mutate(selectedFiles, {
      onSuccess: ({ successes, failures }) => {
        setUploadProgress(null);

        void queryClient.invalidateQueries({
          queryKey: ["document-sources"],
        });

        if (successes.length) {
          abandonCurrentGeneration();
          const nextSources = successes.map((item) => item.filename);

          setActiveSources(nextSources);
          setMessages([]);
          syncActiveConversation([], nextSources);
          setCopiedMessageIndex(null);
          askMutation.reset();
          deleteMutation.reset();

        }

        const failedNames = new Set(
          failures.map((failure) => failure.filename.toLowerCase()),
        );

        setSelectedFiles((current) =>
          failures.length
            ? current.filter((file) => failedNames.has(file.name.toLowerCase()))
            : [],
        );
        setFileError(null);

        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      },
      onError: (error) => {
        setUploadProgress(null);
        setFileError(getApiErrorMessage(error));
      },
      onSettled: () => {
        void queryClient.invalidateQueries({
          queryKey: ["document-sources"],
        });
      },
    });
  }

  function handleDeleteSource() {
    if (!selectedSources.length || deleteMutation.isPending) {
      return;
    }

    deleteMutation.reset();
    setRemoveConfirmationSources([...selectedSources]);
  }

  function handleConfirmDeleteSource() {
    const sourcesToDelete = removeConfirmationSources;

    if (!sourcesToDelete.length || deleteMutation.isPending) {
      return;
    }

    deleteMutation.reset();
    deleteMutation.mutate(sourcesToDelete, {
      onSuccess: ({ successes, failures }) => {
        const deletedSources = new Set(
          successes.map((item) => item.source),
        );

        if (successes.length) {
          void queryClient.invalidateQueries({
            queryKey: ["document-sources"],
          });
          abandonCurrentGeneration();
          const nextSources = selectedSources.filter(
            (source) => !deletedSources.has(source),
          );

          setActiveSources(nextSources);
          setMessages([]);
          syncActiveConversation([], nextSources);
          setCopiedMessageIndex(null);
          askMutation.reset();
        }

        if (failures.length) {
          setRemoveConfirmationSources(
            failures.map((failure) => failure.source),
          );
          return;
        }

        setRemoveConfirmationSources([]);
        setIsKnowledgePanelOpen(false);
      },
    });
  }

  function handleQuestionSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedQuestion = question.trim();

    if (
      !trimmedQuestion ||
      generationStatusRef.current !== "idle" ||
      streamingAnswer !== null
    ) {
      return;
    }

    const generationId = ++nextGenerationIdRef.current;
    activeGenerationIdRef.current = generationId;
    updateGenerationStatus("running");
    isNearBottomRef.current = true;
    setShowScrollToLatest(false);
    askMutation.reset();
    setStreamingAnswer(null);
    const nextMessages = [
      ...visibleMessages,
      { role: "user" as const, content: trimmedQuestion },
      { role: "assistant" as const, content: "", sources: [] },
    ].slice(-maxStoredMessages);
    setMessages(nextMessages);
    syncActiveConversation(nextMessages);
    askMutation.mutate(
      {
        input: {
          question: trimmedQuestion,
          sources: selectedSources,
          history: visibleMessages.slice(-10),
        },
        generationId,
      },
      {
        onSuccess: (data) => {
          if (activeGenerationIdRef.current !== data.generationId) {
            return;
          }

          if (data.cancelled) {
            setStreamingAnswer(null);
            setMessages((current) => removePendingAssistant(current));
            finishGeneration(data.generationId);
            return;
          }

          if (generationStatusRef.current !== "running") {
            return;
          }

          const updatedAt = getCurrentTimestamp();

          setMessages((current) =>
            completeAssistantMessage(current, data.answer, data.sources),
          );
          setConversations((current) => {
            const conversation = current.find(
              (item) => item.id === activeConversationId,
            );

            if (!conversation) {
              return current;
            }

            return updateStoredConversation(
              current,
              activeConversationId,
              completeAssistantMessage(
                conversation.messages,
                data.answer,
                data.sources,
              ),
              getConversationSources(conversation),
              updatedAt,
            );
          });
          setStreamingAnswer(null);
          setQuestion("");
          finishGeneration(data.generationId);
        },
        onError: () => {
          if (activeGenerationIdRef.current !== generationId) {
            return;
          }

          setStreamingAnswer(null);
          setMessages((current) => removePendingAssistant(current));
          finishGeneration(generationId);
        },
      },
    );
  }

  function handleQuestionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function handleSuggestedQuestion(suggestion: string) {
    setQuestion(suggestion);
    questionInputRef.current?.focus();
  }

  const statusLabel =
    sourcesQuery.isLoading || healthQuery.isLoading
      ? "Checking database"
      : connectionIsDegraded
        ? "Database unavailable"
        : undefined;
  const hasTransientUploadFailure = Boolean(
    uploadMutation.isSuccess &&
    uploadMutation.data?.failures.some((failure) => failure.isTransient),
  );
  const hasEmbeddingLimitFailure = Boolean(
    uploadMutation.isSuccess &&
    uploadMutation.data?.failures.some((failure) =>
      /embedding limit|rate limit|quota|too many requests/i.test(
        failure.message,
      ),
    ),
  );
  const uploadFailureHeading = hasEmbeddingLimitFailure
    ? "Please wait before retrying."
    : hasTransientUploadFailure
      ? "Almost there — the document service is starting."
      : "We couldn't upload some files.";
  const uploadFailureSummary = uploadMutation.data?.failures
    .map((failure) => failure.filename + ": " + failure.message)
    .join(" ");
  const deleteFailureMessage = deleteMutation.data?.failures.length
    ? deleteMutation.data.failures
        .map((failure) => failure.source + ": " + failure.message)
        .join(" ")
    : null;
  const selectedScopeLabel =
    selectedSources.length === 0
      ? "No documents selected"
      : selectedSources.length === 1
        ? selectedSources[0]
        : selectedSources.length + " documents selected";
  const selectedScopeTitle = selectedSources.join(", ");

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="mobile-topbar-brand">
          <BrandLogo />
        </div>

        <div className="topbar-tip" role="note">
          <span className="tip-icon">
            <LightbulbIcon />
          </span>
          <p>
            <strong>Helpful tip</strong>
            <span>Ask specific questions for the most relevant source excerpts.</span>
          </p>
        </div>

        <div className="topbar-actions">
          {statusLabel && (
            <div
              className={
                "status-pill sr-only" +
                (connectionIsDegraded ? " status-error" : "")
              }
              role="status"
              aria-live="polite"
              aria-label={statusLabel}
            >
              <span className="status-dot" />
              <span className="status-label">{statusLabel}</span>
            </div>
          )}

          <a
            className="guide-link"
            href="#guide"
            aria-label="Open guide"
            onClick={(event) => {
              event.preventDefault();
              setIsWelcomeOpen(true);
            }}
          >
            <GuideIcon />
            <span>Guide</span>
          </a>

          <nav className="topbar-legal-nav" aria-label="Legal navigation">
            <button
              type="button"
              onClick={() => setActiveLegalDocument("terms")}
              aria-haspopup="dialog"
              aria-label="Terms and Conditions"
            >
              <span className="topbar-legal-full">Terms &amp; Conditions</span>
              <span className="topbar-legal-short">Terms</span>
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => setActiveLegalDocument("privacy")}
              aria-haspopup="dialog"
              aria-label="Privacy Policy"
            >
              <span className="topbar-legal-full">Privacy Policy</span>
              <span className="topbar-legal-short">Privacy</span>
            </button>
          </nav>

          <button
            type="button"
            className="mobile-menu-button"
            aria-controls="knowledge-panel"
            aria-expanded={isKnowledgePanelOpen}
            aria-label={
              isKnowledgePanelOpen
                ? "Close knowledge panel"
                : "Open knowledge panel"
            }
            onClick={toggleKnowledgePanel}
          >
            <MenuIcon />
          </button>
        </div>
      </header>

      <div className="app-layout">
        <aside
          id="knowledge-panel"
          className={"sidebar" + (isKnowledgePanelOpen ? " is-open" : "")}
          aria-label="Knowledge tools"
        >
          <div className="sidebar-brand">
            <BrandLogo />
          </div>

          <div className="mobile-sidebar-header">
            <span>Knowledge tools</span>
            <button
              type="button"
              className="mobile-sidebar-close"
              onClick={() => setIsKnowledgePanelOpen(false)}
            >
              Close
            </button>
          </div>

          <section className="panel upload-panel">
            <div className="panel-heading">
              <span className="panel-heading-icon upload-heading-icon">
                <FileIcon />
              </span>
              <div>
                <p className="eyebrow">Add knowledge</p>
                <h2>Upload documents</h2>
              </div>
            </div>

            <p className="panel-description">
              Add one or more PDF, DOCX, or text files up to 10 MB each.
            </p>

            <form onSubmit={handleFileSubmit}>
              <label
                htmlFor="document-upload"
                className={"dropzone" + (isDragging ? " is-dragging" : "")}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleFileDrop}
              >
                <input
                  ref={fileInputRef}
                  id="document-upload"
                  className="visually-hidden-input"
                  type="file"
                  multiple
                  accept=".txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={(event) => {
                    handleFilesSelected(event.target.files ?? []);
                  }}
                />

                <span className="dropzone-icon">
                  <CloudUploadIcon />
                </span>
                <span className="dropzone-title">Drop files here</span>
                <span className="dropzone-copy">
                  or <u>browse from your computer</u>
                </span>
              </label>

              {selectedFiles.length > 0 && (
                <div className="selected-files" aria-label="Selected files">
                  {selectedFiles.map((file, index) => (
                    <div
                      className="selected-file"
                      key={file.name + "-" + file.lastModified + "-" + index}
                    >
                      <span className="file-icon-wrap">
                        <FileIcon />
                      </span>

                      <span className="selected-file-details">
                        <strong title={file.name}>{file.name}</strong>
                        <small>{formatFileSize(file.size)}</small>
                      </span>

                      <button
                        type="button"
                        className="icon-button"
                        aria-label={"Remove " + file.name}
                        disabled={uploadMutation.isPending}
                        onClick={() => removeSelectedFile(index)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {fileError && (
                <p className="inline-error" role="alert">
                  {fileError}
                </p>
              )}

              {uploadMutation.isPending && uploadProgress && (
                <div className="upload-progress" aria-live="polite">
                  <div className="upload-progress-label">
                    <span>
                      {uploadProgress.percent < 100
                        ? uploadProgress.totalFiles > 1
                          ? "Uploading document " +
                            uploadProgress.currentFile +
                            " of " +
                            uploadProgress.totalFiles
                          : "Uploading file"
                        : uploadProgress.totalFiles > 1
                          ? "Indexing document " +
                            uploadProgress.currentFile +
                            " of " +
                            uploadProgress.totalFiles
                          : "Indexing chunks"}
                    </span>
                    <span>
                      {uploadProgress.percent < 100
                        ? uploadProgress.percent + "%"
                        : "Ready soon"}
                    </span>
                  </div>
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-label="Document upload progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={uploadProgress.percent}
                  >
                    <span
                      className="progress-fill"
                      style={{ width: uploadProgress.percent + "%" }}
                    />
                  </div>
                </div>
              )}

              <button
                className="primary-button upload-button"
                type="submit"
                disabled={!selectedFiles.length || uploadMutation.isPending}
              >
                {uploadMutation.isPending && (
                  <LoadingSpinner className="button-loading-spinner" />
                )}
                {uploadMutation.isPending
                  ? uploadProgress && uploadProgress.totalFiles > 1
                    ? "Uploading " +
                      uploadProgress.currentFile +
                      " of " +
                      uploadProgress.totalFiles +
                      "..."
                    : uploadProgress && uploadProgress.percent < 100
                      ? "Uploading..."
                      : "Indexing document..."
                  : hasTransientUploadFailure
                    ? selectedFiles.length > 1
                      ? "Retry failed files"
                      : "Retry upload"
                    : selectedFiles.length > 1
                      ? "Upload " + selectedFiles.length + " files"
                      : "Upload"}
                {!uploadMutation.isPending && (
                  <>
                    <UploadIcon />
                    <span aria-hidden="true">→</span>
                  </>
                )}
              </button>
            </form>

            {uploadMutation.isSuccess &&
            uploadMutation.data?.successes.length ? (
              <div className="notice success-notice" role="status">
                <span className="notice-icon" aria-hidden="true">
                  ✓
                </span>
                <span className="notice-copy">
                  <strong>Upload successful</strong>
                  <small
                    title={uploadMutation.data.successes
                      .map((item) => item.filename)
                      .join(", ")}
                  >
                    {uploadMutation.data.successes.length === 1
                      ? uploadMutation.data.successes[0].filename +
                        " is ready to use."
                      : uploadMutation.data.successes.length +
                        " documents are ready to use."}
                  </small>
                </span>
              </div>
            ) : null}

            {uploadMutation.isSuccess &&
            uploadMutation.data?.failures.length ? (
              <div className="notice error-notice" role="alert">
                <span className="notice-icon">!</span>
                <span className="notice-copy">
                  <strong>{uploadFailureHeading}</strong>
                  <small>
                    {uploadFailureSummary}
                    {hasTransientUploadFailure
                      ? " Your file is still selected. Try again in a moment."
                      : ""}
                  </small>
                </span>
              </div>
            ) : null}

            {uploadMutation.isError && (
              <div className="notice error-notice" role="alert">
                <span className="notice-icon">!</span>
                <span>{getApiErrorMessage(uploadMutation.error)}</span>
              </div>
            )}
          </section>

          <section className="panel scope-panel">
            <div className="panel-heading">
              <span className="panel-heading-icon scope-heading-icon">
                <DatabaseIcon />
              </span>
              <div>
                <p className="eyebrow">Search scope</p>
                <h2>Knowledge base</h2>
              </div>
            </div>

            <p className="panel-description">
              Choose one or more uploaded documents the AI should read.
            </p>

            <div className="scope-selector">
              {sourcesQuery.isLoading && (
                <div className="scope-loading-state" role="status">
                  <LoadingSpinner className="scope-loading-spinner" />
                  <span>Loading documents...</span>
                </div>
              )}

              {(sourcesQuery.data ?? []).length > 0 && (
                <div
                  className="document-scope-list"
                  role="group"
                  aria-label="Choose documents for AI answers"
                >
              {(sourcesQuery.data ?? []).map((source, index) => {
                const isSelected = selectedSources.includes(source);

                return (
                  <label
                    className={
                      "document-scope-option" +
                      (isSelected ? " is-selected" : "")
                    }
                    htmlFor={"document-scope-" + index}
                    key={source}
                    title={source}
                  >
                    <input
                      className="document-scope-input"
                      id={"document-scope-" + index}
                      name="document-scope"
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => handleSourceChange(source)}
                    />
                    <span className="document-scope-check" aria-hidden="true" />
                    <span className="document-scope-option-copy">
                      <strong>{source}</strong>
                      <small>
                        {isSelected
                          ? "Included in this chat"
                          : "Select to include"}
                      </small>
                    </span>
                  </label>
                );
                  })}
                </div>
              )}

              {!sourcesQuery.isLoading &&
                !sourcesQuery.isFetching &&
                !sourcesQuery.isError &&
                !(sourcesQuery.data ?? []).length && (
                  <p className="scope-empty-state">
                    Upload documents to choose a search scope.
                  </p>
                )}
            </div>

            {selectedSources.length > 0 && (
              <p className="scope-selection-summary" role="status">
                {selectedSources.length} document
                {selectedSources.length === 1 ? "" : "s"} selected for this
                chat.
              </p>
            )}

            {sourcesQuery.isError && (
              <>
                <p className="inline-error" role="alert">
                  {getApiErrorMessage(sourcesQuery.error)}
                </p>
                <button
                  type="button"
                  className="secondary-button retry-button"
                  onClick={() => {
                    void Promise.all([
                      sourcesQuery.refetch(),
                      healthQuery.refetch(),
                    ]);
                  }}
                  disabled={sourcesQuery.isFetching || healthQuery.isFetching}
                >
                  {sourcesQuery.isFetching || healthQuery.isFetching ? (
                    <>
                      <LoadingSpinner className="inline-loading-spinner" />
                      Checking...
                    </>
                  ) : (
                    "Retry connection"
                  )}
                </button>
              </>
            )}

            {healthQuery.data?.status === "degraded" &&
              !sourcesQuery.isError && (
                <>
                  <p className="inline-error" role="alert">
                    {healthQuery.data.message
                      ? getApiErrorMessage(new Error(healthQuery.data.message))
                      : "The document service is currently unavailable. Please try again in a moment."}
                  </p>
                  <button
                    type="button"
                    className="secondary-button retry-button"
                    onClick={() => {
                      void Promise.all([
                        sourcesQuery.refetch(),
                        healthQuery.refetch(),
                      ]);
                    }}
                    disabled={sourcesQuery.isFetching || healthQuery.isFetching}
                  >
                    {sourcesQuery.isFetching || healthQuery.isFetching ? (
                      <>
                        <LoadingSpinner className="inline-loading-spinner" />
                        Checking...
                      </>
                    ) : (
                      "Retry connection"
                    )}
                  </button>
                </>
              )}

            {selectedSources.length > 0 && (
              <button
                type="button"
                className="danger-button"
                onClick={handleDeleteSource}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending
                  ? selectedSources.length > 1
                    ? "Removing documents..."
                    : "Removing document..."
                  : selectedSources.length > 1
                    ? "Remove selected documents"
                    : "Remove selected document"}
              </button>
            )}

            {deleteMutation.isSuccess &&
              deleteMutation.data.successes.length > 0 && (
              <p className="field-help" role="status">
                Removed {deleteMutation.data.successes.length} document
                {deleteMutation.data.successes.length === 1 ? "" : "s"} and{" "}
                {deleteMutation.data.successes.reduce(
                  (total, item) => total + item.deletedChunks,
                  0,
                )}{" "}
                indexed chunks.
              </p>
              )}

            {deleteMutation.isError && (
              <p className="inline-error" role="alert">
                {getApiErrorMessage(deleteMutation.error)}
              </p>
            )}
          </section>

        </aside>

        {isKnowledgePanelOpen && (
          <button
            type="button"
            className="sidebar-backdrop"
            aria-label="Close knowledge panel"
            onClick={() => setIsKnowledgePanelOpen(false)}
          />
        )}

        <main className="chat-panel">
          <div className="chat-header">
            <div className="chat-header-icon">
              <ConversationIcon />
            </div>

            <div className="chat-header-copy">
              <p className="eyebrow">Conversation</p>
              <h2>Ask questions. Find clear answers.</h2>
            </div>

            <button
              type="button"
              className="secondary-button new-chat-button"
              onClick={startNewConversation}
            >
              <span className="new-chat-icon" aria-hidden="true">
                +
              </span>
              New chat
            </button>
          </div>

          <div className="chat-content-wrap">
            <div
              ref={chatContentRef}
              className="chat-content"
              aria-live="polite"
              onScroll={handleChatScroll}
            >
              {visibleMessages.length === 0 && generationStatus === "idle" && (
                <div className="empty-state">
                  <DocumentOrbitIllustration />

                  {documentCount > 0 && (
                    <p className="eyebrow">Ready when you are</p>
                  )}
                  <h3>
                    {documentCount > 0
                      ? "Start a conversation with your knowledge base."
                      : "Upload a document to get started."}
                  </h3>
                  <p className="empty-state-copy">
                    {documentCount > 0
                      ? "Ask a question, request a summary, or explore the ideas inside your indexed documents."
                      : "Your document will be split into searchable chunks, so you can ask questions about its content."}
                  </p>

                  {documentCount === 0 && !selectedFiles.length && (
                    <button
                      type="button"
                      className="empty-state-upload-button"
                      aria-controls="knowledge-panel"
                      aria-expanded={isKnowledgePanelOpen}
                      onClick={() => {
                        setIsMobileScopeOpen(false);
                        setIsKnowledgePanelOpen(true);
                      }}
                    >
                      <CloudUploadIcon />
                      Upload documents
                    </button>
                  )}

                  {documentCount === 0 && (
                    <div className="empty-state-features">
                      <div className="empty-state-feature">
                        <span className="empty-state-feature-icon">
                          <FileIcon />
                        </span>
                        <span>
                          <strong>PDF, DOCX, TXT</strong>
                          <small>Up to 10 MB each</small>
                        </span>
                      </div>
                      <div className="empty-state-feature">
                        <span className="empty-state-feature-icon">
                          <SearchIcon />
                        </span>
                        <span>
                          <strong>Searchable chunks</strong>
                          <small>Find precise answers</small>
                        </span>
                      </div>
                      <div className="empty-state-feature">
                        <span className="empty-state-feature-icon">
                          <SparkIcon />
                        </span>
                        <span>
                          <strong>Ask anything</strong>
                          <small>Get insights from your docs</small>
                        </span>
                      </div>
                    </div>
                  )}

                  {documentCount > 0 && (
                    <div className="suggestions">
                      {suggestedQuestions.map((suggestion) => (
                        <button
                          type="button"
                          className="suggestion-button"
                          key={suggestion}
                          onClick={() => handleSuggestedQuestion(suggestion)}
                        >
                          <span aria-hidden="true">✦</span>
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {visibleMessages.map((message, index) => {
                const isTypingThisMessage =
                  message.role === "assistant" &&
                  index === visibleMessages.length - 1 &&
                  (streamingAnswer !== null || generationStatus === "running");

                return (
                  <div
                    className={"message-row " + message.role}
                    key={message.role + "-" + index}
                  >
                    {message.role === "assistant" ? (
                      <AssistantIcon />
                    ) : (
                      <div className="message-avatar" aria-hidden="true">
                        <span className="user-avatar-mark" />
                      </div>
                    )}

                    <article className="message-card">
                      {message.role === "assistant" && !isTypingThisMessage && (
                        <div className="message-meta">
                          {message.content && (
                            <button
                              type="button"
                              className="message-action"
                              onClick={() =>
                                void handleCopyAnswer(message.content, index)
                              }
                              aria-label="Copy assistant answer"
                            >
                              {copiedMessageIndex === index ? "Copied" : "Copy"}
                            </button>
                          )}
                        </div>
                      )}

                      {message.role === "assistant" ? (
                        isTypingThisMessage ? (
                          streamingAnswer === null ? (
                            <ThinkingLoader />
                          ) : (
                            <p className="typing-content">
                              {streamingAnswer}
                              <span
                                className="typing-caret"
                                aria-hidden="true"
                              />
                            </p>
                          )
                        ) : (
                          <div className="markdown-content">
                            <Suspense
                              fallback={
                                <p className="markdown-loading" aria-live="polite">
                                  Formatting answer...
                                </p>
                              }
                            >
                              <MarkdownContent content={message.content} />
                            </Suspense>
                          </div>
                        )
                      ) : (
                        <p className="user-message-content">
                          {message.content}
                        </p>
                      )}
                    </article>
                  </div>
                );
              })}

              {askMutation.isError && (
                <div className="error-banner" role="alert">
                  <span className="notice-icon">!</span>
                  <span>{getApiErrorMessage(askMutation.error)}</span>
                </div>
              )}
            </div>

            {showScrollToLatest && (
              <button
                type="button"
                className="scroll-latest-button"
                onClick={scrollToLatest}
                aria-label="Scroll to latest message"
              >
                <ArrowDownIcon />
                Latest
              </button>
            )}
          </div>

          <div className="composer-shell">
            <div className="composer-context desktop-composer-context">
              <span className="composer-context-icon">
                <DatabaseIcon />
              </span>
              <span
                className="composer-context-label"
                title={selectedScopeTitle || undefined}
              >
                {generationStatus === "stopping"
                  ? "Stopping response..."
                  : streamingAnswer !== null
                    ? "Assistant is writing a response..."
                    : selectedSources.length
                      ? "Document scope: " + selectedScopeLabel
                      : "Document scope: choose a document"}
              </span>
              <ChevronDownIcon />
            </div>

            {!isKnowledgePanelOpen && (
              <div className="mobile-scope-control">
                <button
                  type="button"
                  className="mobile-scope-trigger"
                  aria-controls="mobile-document-scope"
                  aria-expanded={isMobileScopeOpen}
                  onClick={() => setIsMobileScopeOpen((isOpen) => !isOpen)}
                >
                  <span className="composer-context-icon">
                    <DatabaseIcon />
                  </span>
                  <span
                    className="composer-context-label"
                    title={selectedScopeTitle || undefined}
                  >
                    {selectedSources.length
                      ? "Document scope: " + selectedScopeLabel
                      : "Document scope: choose a document"}
                  </span>
                  <ChevronDownIcon />
                </button>

                {isMobileScopeOpen && (
                  <div
                    id="mobile-document-scope"
                    className="mobile-scope-picker"
                    role="group"
                    aria-label="Choose documents for AI answers"
                  >
                    <div className="mobile-scope-picker-heading">
                      <strong>Select documents</strong>
                      <span>
                        {selectedSources.length
                          ? selectedSources.length + " selected"
                          : "Choose one or more"}
                      </span>
                    </div>

                    {sourcesQuery.isLoading && (
                      <div className="scope-loading-state" role="status">
                        <LoadingSpinner className="scope-loading-spinner" />
                        <span>Loading documents...</span>
                      </div>
                    )}

                    {sourcesQuery.isError && (
                      <p className="mobile-scope-empty" role="alert">
                        Could not load your documents. Open the sidebar to retry.
                      </p>
                    )}

                    {!sourcesQuery.isLoading &&
                      !sourcesQuery.isError &&
                      (sourcesQuery.data ?? []).length > 0 && (
                        <div className="mobile-scope-options">
                          {(sourcesQuery.data ?? []).map((source, index) => {
                            const isSelected = selectedSources.includes(source);

                            return (
                              <label
                                className={
                                  "document-scope-option" +
                                  (isSelected ? " is-selected" : "")
                                }
                                htmlFor={"mobile-document-scope-" + index}
                                key={source}
                                title={source}
                              >
                                <input
                                  className="document-scope-input"
                                  id={"mobile-document-scope-" + index}
                                  name="mobile-document-scope"
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => handleSourceChange(source)}
                                />
                                <span
                                  className="document-scope-check"
                                  aria-hidden="true"
                                />
                                <span className="document-scope-option-copy">
                                  <strong>{source}</strong>
                                  <small>
                                    {isSelected
                                      ? "Included in this chat"
                                      : "Select to include"}
                                  </small>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}

                    {!sourcesQuery.isLoading &&
                      !sourcesQuery.isError &&
                      !(sourcesQuery.data ?? []).length && (
                        <p className="mobile-scope-empty">
                          Upload documents to choose a search scope.
                        </p>
                      )}
                  </div>
                )}
              </div>
            )}

            <form className="composer" onSubmit={handleQuestionSubmit}>
              <div className="composer-input-row">
                <textarea
                  ref={questionInputRef}
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={handleQuestionKeyDown}
                  placeholder="Ask a question about your documents..."
                  aria-label="Ask a question about your documents"
                  rows={2}
                  disabled={
                    generationStatus !== "idle" || streamingAnswer !== null
                  }
                />
              </div>

              <div className="composer-toolbar">
                {generationStatus !== "idle" ? (
                  <button
                    className="send-button stop-button"
                    type="button"
                    onClick={handleStopClick}
                    disabled={generationStatus === "stopping"}
                    aria-label="Stop generating response"
                  >
                    <span aria-hidden="true">■</span>
                    {generationStatus === "stopping" ? "Stopping…" : "Stop"}
                  </button>
                ) : (
                  <button
                    className="send-button ask-button"
                    type="submit"
                    disabled={!question.trim() || !selectedSources.length}
                  >
                    Ask
                    <SendIcon />
                  </button>
                )}
              </div>
            </form>
          </div>
        </main>
      </div>

      <WelcomeModal
        key={isWelcomeOpen ? "open" : "closed"}
        isOpen={isWelcomeOpen}
        onClose={closeWelcomeModal}
        onUpload={handleWelcomeUpload}
      />

      <RemoveConfirmationModal
        sources={removeConfirmationSources}
        isRemoving={deleteMutation.isPending}
        error={
          deleteMutation.isError
            ? getApiErrorMessage(deleteMutation.error)
            : deleteFailureMessage
        }
        onCancel={() => setRemoveConfirmationSources([])}
        onConfirm={handleConfirmDeleteSource}
      />

      <LegalModal
        legalDocument={activeLegalDocument}
        onClose={closeLegalModal}
      />
    </div>
  );
}

export default App;
