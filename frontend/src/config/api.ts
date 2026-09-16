import axios from "axios";

export type RagSource = {
  score?: number;
  content: string;
  metadata: {
    source?: string;
    loc?: {
      pageNumber?: number;
    };
  };
};

export type RagResponse = {
  answer: string;
  sources: RagSource[];
};

export type RagStreamEvent =
  | { type: "token"; token: string }
  | { type: "sources"; sources: RagSource[] }
  | { type: "error"; message: string }
  | { type: "done" };

export type UploadResponse = {
  message: string;
  filename: string;
  chunks: number;
};

export type SourcesResponse = {
  sources: string[];
};

export type DeleteSourceResponse = {
  message: string;
  source: string;
  deletedChunks: number;
};

export type HealthResponse = {
  status: "ok" | "degraded";
  api: "ok";
  astra: "ready" | "unavailable";
  message?: string;
};

export type SessionResponse = {
  csrfToken: string;
};

export type ClearSessionResponse = {
  message: string;
  deletedChunks: number;
};

export type SessionActivityResponse = {
  message: string;
};

export type AskQuestionInput = {
  question: string;
  source?: string;
  sources?: string[];
  history?: ChatMessage[];
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  sources?: RagSource[];
};

const defaultApiPort = "3005";

function isLocalDevelopmentHost(hostname: string): boolean {
  const normalizedHostname = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  return (
    normalizedHostname === 'localhost' ||
    normalizedHostname === '127.0.0.1' ||
    normalizedHostname === '::1' ||
    normalizedHostname.endsWith('.local') ||
    /^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(normalizedHostname) ||
    /^192\.168\.(?:\d{1,3}\.)\d{1,3}$/.test(normalizedHostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}$/.test(
      normalizedHostname,
    )
  );
}

function resolveApiBaseUrl(): string {
  const configuredApiUrl = import.meta.env.VITE_API_URL?.trim();

  if (typeof window === 'undefined') {
    return configuredApiUrl || `http://localhost:${defaultApiPort}`;
  }

  const pageHostname = window.location.hostname || 'localhost';

  if (!configuredApiUrl) {
    if (import.meta.env.PROD) {
      // A production build is expected to be served behind the same origin as
      // the API, or to provide VITE_API_URL explicitly. Never point a deployed
      // build at a developer's localhost by default.
      return window.location.origin;
    }

    const fallbackHostname = isLocalDevelopmentHost(pageHostname)
      ? pageHostname
      : 'localhost';

    return `http://${fallbackHostname}:${defaultApiPort}`;
  }

  try {
    const resolvedUrl = new URL(configuredApiUrl);

    // A LAN API URL is commonly supplied so phones can reach the backend.
    // When the same build is opened on the development computer through
    // localhost, use localhost for the API as well so session cookies remain
    // first-party.  When opened on a phone, the LAN hostname is preserved.
    if (
      isLocalDevelopmentHost(pageHostname) &&
      isLocalDevelopmentHost(resolvedUrl.hostname)
    ) {
      resolvedUrl.hostname = pageHostname;
    }

    return resolvedUrl.toString().replace(/\/$/, '');
  } catch {
    return configuredApiUrl.replace(/\/$/, '');
  }
}

const apiBaseUrl = resolveApiBaseUrl();

export const api = axios.create({
  baseURL: apiBaseUrl,
  withCredentials: true,
});

let csrfToken: string | undefined;
let csrfTokenRequest: Promise<string> | undefined;
let csrfRefreshRequest: Promise<string> | undefined;

type CsrfRetryConfig = {
  _csrfRetried?: boolean;
};

async function getCsrfToken(): Promise<string> {
  if (csrfToken) {
    return csrfToken;
  }

  if (csrfRefreshRequest) {
    return csrfRefreshRequest;
  }

  if (!csrfTokenRequest) {
    csrfTokenRequest = api
      .get<SessionResponse>("/session")
      .then((response) => {
        csrfToken = response.data.csrfToken;

        return csrfToken;
      })
      .finally(() => {
        csrfTokenRequest = undefined;
      });
  }

  return csrfTokenRequest;
}

function refreshCsrfToken(): Promise<string> {
  if (!csrfRefreshRequest) {
    csrfToken = undefined;
    csrfRefreshRequest = api
      .get<SessionResponse>('/session')
      .then((response) => {
        csrfToken = response.data.csrfToken;

        return csrfToken;
      })
      .finally(() => {
        csrfRefreshRequest = undefined;
      });
  }

  return csrfRefreshRequest;
}

function isInvalidCsrfError(error: unknown): boolean {
  if (!axios.isAxiosError<{ message?: string | string[] }>(error)) {
    return false;
  }

  const message = error.response?.data?.message;

  return (
    error.response?.status === 403 &&
    typeof message === 'string' &&
    /invalid csrf token/i.test(message)
  );
}

api.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (!isInvalidCsrfError(error) || !axios.isAxiosError(error)) {
      return Promise.reject(error);
    }

    const requestConfig = error.config as
      | (NonNullable<typeof error.config> & CsrfRetryConfig)
      | undefined;

    if (!requestConfig || requestConfig._csrfRetried) {
      return Promise.reject(error);
    }

    requestConfig._csrfRetried = true;

    // The cached token can be out of sync with the HTTP-only cookie after a
    // refresh, a second tab clears the session, or the browser restores a
    // suspended page.  Calling getCsrfToken() here would return that stale
    // value and make the retry fail again.  Always fetch the current session
    // token when the server explicitly rejects the token we sent.
    const tokenToRefresh = refreshCsrfToken();

    try {
      const freshToken = await tokenToRefresh;

      if (requestConfig.headers) {
        const headers = requestConfig.headers as typeof requestConfig.headers & {
          set?: (name: string, value: string) => void;
        };

        if (typeof headers.set === 'function') {
          headers.set('X-CSRF-Token', freshToken);
        } else {
          headers['X-CSRF-Token'] = freshToken;
        }
      }

      return api.request(requestConfig);
    } catch {
      return Promise.reject(error);
    }
  },
);

async function fetchWithCsrfRetry(
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);

  if (response.status !== 403) {
    return response;
  }

  const payload = (await response.clone().json().catch(() => null)) as {
    message?: unknown;
  } | null;

  if (payload?.message !== 'Invalid CSRF token') {
    return response;
  }

  const freshToken = await refreshCsrfToken();
  const headers = new Headers(init.headers);
  headers.set('X-CSRF-Token', freshToken);

  return fetch(input, {
    ...init,
    headers,
  });
}

export async function askQuestion({
  question,
  source,
  sources,
  history,
}: AskQuestionInput): Promise<RagResponse> {
  const token = await getCsrfToken();
  const response = await api.post<RagResponse>(
    "/rag/ask",
    {
      question,
      ...(sources?.length ? { sources } : source ? { source } : {}),
      history: (history ?? []).map(({ role, content }) => ({
        role,
        content,
      })),
    },
    {
      headers: {
        "X-CSRF-Token": token,
      },
    },
  );

  return response.data;
}

export async function askQuestionStream(
  input: AskQuestionInput,
  onEvent: (event: RagStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = await getCsrfToken();
  const response = await fetchWithCsrfRetry(apiBaseUrl + "/rag/stream", {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "X-CSRF-Token": token,
    },
    body: JSON.stringify({
      question: input.question,
      ...(input.sources?.length
        ? { sources: input.sources }
        : input.source
          ? { source: input.source }
          : {}),
      history: (input.history ?? []).map(({ role, content }) => ({
        role,
        content,
      })),
    }),
    credentials: "include",
    signal,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      message?: unknown;
    } | null;
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : `Request failed with status ${response.status}.`;

    throw new Error(message);
  }

  if (!response.body) {
    throw new Error("Streaming responses are not supported by this browser.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitBlock = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");

    if (!data) {
      return;
    }

    const event = JSON.parse(data) as RagStreamEvent;

    if (event.type === "error") {
      throw new Error(event.message);
    }

    onEvent(event);
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      emitBlock(block);
    }

    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    emitBlock(buffer);
  }
}

export async function uploadDocument(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<UploadResponse> {
  const token = await getCsrfToken();
  const formData = new FormData();

  formData.append("file", file);

  const response = await api.post<UploadResponse>("/documents/file", formData, {
    headers: {
      "X-CSRF-Token": token,
    },
    onUploadProgress: (event) => {
      if (event.total) {
        onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    },
  });

  return response.data;
}

export async function listSources(): Promise<string[]> {
  await getCsrfToken();
  const response = await api.get<SourcesResponse>("/documents/sources");

  return response.data.sources;
}

export async function deleteDocument(
  source: string,
): Promise<DeleteSourceResponse> {
  const token = await getCsrfToken();
  const response = await api.delete<DeleteSourceResponse>("/documents/source", {
    data: { source },
    headers: {
      "X-CSRF-Token": token,
    },
  });

  return response.data;
}

export async function clearSession(): Promise<ClearSessionResponse> {
  const token = await getCsrfToken();
  const response = await api.delete<ClearSessionResponse>('/session', {
    headers: {
      'X-CSRF-Token': token,
    },
  });

  csrfToken = undefined;
  pageExitCloseScheduled = true;

  return response.data;
}

export async function touchSession(): Promise<void> {
  const token = await getCsrfToken();

  await api.post<SessionActivityResponse>('/session/heartbeat', undefined, {
    headers: {
      'X-CSRF-Token': token,
    },
  });
}

let pageExitCloseScheduled = false;

export function scheduleSessionCloseOnPageExit(): void {
  if (!csrfToken || pageExitCloseScheduled) {
    return;
  }

  pageExitCloseScheduled = true;

  void fetch(apiBaseUrl + '/session/close', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'X-CSRF-Token': csrfToken,
    },
    credentials: 'include',
    keepalive: true,
  }).catch(() => {
    // The heartbeat timeout remains the fallback if a browser stops this
    // keepalive request while closing the page.
  });
}

export async function getHealth(): Promise<HealthResponse> {
  await getCsrfToken();
  const response = await api.get<HealthResponse>("/health");

  return response.data;
}

type ApiErrorDetails = {
  message: string;
  status?: number;
};

function getApiErrorDetails(error: unknown): ApiErrorDetails {
  if (axios.isAxiosError<{ message?: string | string[] }>(error)) {
    const message = error.response?.data?.message;

    if (Array.isArray(message)) {
      return {
        message: message.join(", "),
        status: error.response?.status,
      };
    }

    if (typeof message === "string") {
      return {
        message,
        status: error.response?.status,
      };
    }

    return {
      message: error.message,
      status: error.response?.status,
    };
  }

  return {
    message:
      error instanceof Error ? error.message : "An unexpected error occurred.",
  };
}

function getFriendlyApiErrorMessage({
  message,
  status,
}: ApiErrorDetails): string {
  const normalizedMessage = message.trim();

  if (
    /astra db (?:is )?(?:waking up|did not respond while waking up)/i.test(
      normalizedMessage,
    ) || /document service (?:is )?(?:waking up|starting)/i.test(normalizedMessage)
  ) {
    return "The document service is starting up. Please wait a moment and try again.";
  }

  if (status === 502 || status === 503 || status === 504) {
    return "The document service is temporarily unavailable. Please try again in a moment.";
  }

  if (/quota|rate limit|too many requests|embedding limit/i.test(normalizedMessage)) {
    return "MC.AI has reached its temporary embedding limit. Please wait about a minute and try again.";
  }

  if (status === 429) {
    return "The document service is busy right now. Please wait about a minute and try again.";
  }

  if (status === 413 || /file size|too large|entity too large/i.test(normalizedMessage)) {
    return "That file is too large. Each file must be 10 MB or smaller.";
  }

  if (
    /network error|failed to fetch|network request|econnrefused|err_connection_|connection (?:refused|reset|timed out)|timed out/i.test(
      normalizedMessage,
    )
  ) {
    return "We couldn't reach the document service. Check your connection and try again.";
  }

  if (/invalid csrf token/i.test(normalizedMessage)) {
    return "Your session could not be verified. Refresh MC.AI and try uploading again.";
  }

  if (/filename is already indexed/i.test(normalizedMessage)) {
    return "A document with this name is already uploaded. Remove it or choose a different filename.";
  }

  return normalizedMessage || "Something went wrong. Please try again.";
}

export function getApiErrorMessage(error: unknown): string {
  return getFriendlyApiErrorMessage(getApiErrorDetails(error));
}

export function isTransientApiError(error: unknown): boolean {
  const details = getApiErrorDetails(error);

  if (
    details.status === 429 ||
    details.status === 502 ||
    details.status === 503 ||
    details.status === 504
  ) {
    return true;
  }

  return /astra db (?:is )?(?:waking up|did not respond while waking up)|network error|failed to fetch|network request|econnrefused|err_connection_|connection (?:refused|reset|timed out)|timed out/i.test(
    details.message,
  );
}
