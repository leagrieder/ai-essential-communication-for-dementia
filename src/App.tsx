'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { authClient, useSession, isAdminFromSession } from '@/lib/auth-client';
import {
  listConversations,
  createConversation,
  patchConversation,
  deleteConversation,
  listMessages,
  appendMessage,
  getPromptSettings,
  ApiConversation,
  ApiMessage,
} from '@/lib/api-client';
import { SidebarHistory } from './components/SidebarHistory';
import { ChatWindow } from './components/ChatWindow';
import { DualChatView } from './components/DualChatView';
import { DualInputForm } from './components/DualInputForm';
import { CompareChatView } from './components/CompareChatView';
import { CompareInputForm } from './components/CompareInputForm';
import { NavigationMap, PhaseName } from './components/NavigationMap';
import { AdminPanel } from './components/AdminPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { ResourcesPanel } from './components/ResourcesPanel';
import {
  generateClinicalResponseWithHistory,
  isInsufficientInfoResponse,
  GenerationResult,
} from './lib/llm';
import type { ResponsePath } from './lib/classifier/types';
import {
  PromptSettings,
  DEFAULT_SUGGESTED_PROMPTS,
} from './lib/promptSettings';
import { Stethoscope, Menu } from 'lucide-react';
import { cn } from './lib/utils';
import { TemplateDevBadge, useTemplateBadge } from './components/TemplateDevBadge';
import { LoginScreen } from './components/LoginScreen';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
  isInsufficientInfo?: boolean;
  lane?: 'single' | 'primary' | 'secondary' | 'basic' | 'condensed';
}

interface AppUser {
  uid: string;
  email: string | null;
  displayName: string | null;
}

interface Conversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  type: 'normal' | 'dual' | 'compare';
  primaryProvider?: string;
  secondaryProvider?: string;
}

const PHASES: { name: PhaseName; steps: string[] }[] = [
  {
    name: 'Recognition',
    steps: ['Open the Conversation', 'Assess Function', 'Assess Cognition', 'Assess Safety'],
  },
  {
    name: 'Evaluation',
    steps: [
      'Assess Function',
      'Assess Cognition',
      'Assess Safety',
      'Targeted Exam',
      'Labs and Imaging',
      'Medication Review',
      'Name Condition',
    ],
  },
  {
    name: 'Naming & Diagnosis',
    steps: [
      'Assess and Align Understanding',
      'Apply Diagnosis',
      'Stage Condition',
      'Address Risks and Concerns',
      'Plan Follow-up',
    ],
  },
];

function parseFrameworkPosition(text: string): { phase: PhaseName | null; step: string | null } {
  const normalized = text.toLowerCase();
  const phase = PHASES.find((candidate) => normalized.includes(candidate.name.toLowerCase().split(' ')[0]));
  let step: string | null = null;
  if (phase) {
    for (const s of phase.steps) {
      if (normalized.includes(s.toLowerCase())) {
        step = s;
      }
    }
  }
  return { phase: phase?.name ?? null, step };
}

function findPhaseForStep(step: string): PhaseName | null {
  for (const p of PHASES) if (p.steps.includes(step)) return p.name;
  return null;
}

function apiConvToLocal(c: ApiConversation): Conversation {
  return {
    id: c.id,
    title: c.title,
    createdAt: new Date(c.createdAt),
    updatedAt: new Date(c.updatedAt),
    type: c.type,
    primaryProvider: c.primaryProvider ?? undefined,
    secondaryProvider: c.secondaryProvider ?? undefined,
  };
}

function apiMsgToLocal(m: ApiMessage): Message {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: new Date(m.createdAt),
    isInsufficientInfo: m.isInsufficientInfo || false,
    lane: m.lane || 'single',
  };
}

export default function App() {
  const [user, setUser] = useState<AppUser | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [currentPhase, setCurrentPhase] = useState<PhaseName | null>(null);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [lastDetectedPhase, setLastDetectedPhase] = useState<PhaseName | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [showResourcesPanel, setShowResourcesPanel] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [promptSettings, setPromptSettings] = useState<PromptSettings | null>(null);
  const [isNavMapOpen, setIsNavMapOpen] = useState(false);
  // Incremented whenever a new consultation starts; the workflow map re-opens
  // each time this changes (Nora: "always open when we open a new consultation").
  const [newConsultationCount, setNewConsultationCount] = useState(0);

  const [responseMode, setResponseMode] = useState<'basic' | 'condensed'>('basic');

  const [dualMessages, setDualMessages] = useState<{
    primary: Message[];
    secondary: Message[];
  }>({ primary: [], secondary: [] });
  const [dualLoading, setDualLoading] = useState<{
    primary: boolean;
    secondary: boolean;
  }>({ primary: false, secondary: false });

  const [compareMessages, setCompareMessages] = useState<{
    basic: Message[];
    condensed: Message[];
  }>({ basic: [], condensed: [] });
  const [compareLoading, setCompareLoading] = useState<{
    basic: boolean;
    condensed: boolean;
  }>({ basic: false, condensed: false });

  // True while we're fetching a compare conversation's message history
  // from the database. Drives the centered loader in CompareChatView so
  // the user has feedback during the fetch (separate from per-pane
  // generation spinners which show while the LLM is responding).
  const [isFetchingCompareMessages, setIsFetchingCompareMessages] = useState(false);

  // True while we're fetching a normal conversation's message history
  // from the database AND that history was not already prefetched.
  // Drives the centered loader in ChatWindow. Prefetched conversations
  // skip this — they render instantly from the in-memory cache and a
  // spinner would just flash for one frame.
  const [isFetchingNormalMessages, setIsFetchingNormalMessages] = useState(false);

  const {
    currentTemplate,
    tier1Complete,
    isVisible: isBadgeVisible,
    updateTemplate,
    hideBadge
  } = useTemplateBadge();

  // Load prompt settings on mount. Gate on auth so we don't fire an
  // unauthenticated request before Better Auth has resolved the session
  // (which would 401 and produce a console error on every page load).
  useEffect(() => {
    if (!isAuthReady || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const { settings, defaults } = await getPromptSettings();
        if (cancelled) return;
        // Merge with defaults so missing fields (older records) still resolve.
        setPromptSettings({ ...defaults, ...(settings ?? {}) } as PromptSettings);
      } catch (error) {
        console.error('Error loading prompt settings:', error);
        if (!cancelled) {
          // Fall back to a static default so the UI keeps working.
          setPromptSettings({
            provider: 'harvard',
            dualModeProvider: 'harvard',
            selectedModel: 'gpt-5.5',
            dualModeSelectedModel: 'gpt-5.5',
            systemPrompt: '',
            stuckModePrompt: '',
            suggestedPrompts: DEFAULT_SUGGESTED_PROMPTS,
            knowledgeContent: '',
            coachingResource: '',
            responseMode: 'basic',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthReady, user]);

  // Auth Listener — Better Auth.
  const isBrowser = typeof window !== 'undefined';
  const { data: session, isPending: sessionPending } = isBrowser
    ? useSession()
    : ({ data: null, isPending: true } as ReturnType<typeof useSession>);
  useEffect(() => {
    if (!isBrowser) return;
    if (sessionPending) return;
    if (session?.user) {
      setUser({
        uid: session.user.id,
        email: session.user.email ?? null,
        displayName: session.user.name ?? null,
      });
    } else {
      setUser(null);
    }
    setIsAuthReady(true);
  }, [session, sessionPending, isBrowser]);

  // Fetch Conversations (via REST API). Re-loads on user change.
  useEffect(() => {
    if (!isAuthReady || !user) return;

    let cancelled = false;
    (async () => {
      try {
        const { conversations: rows } = await listConversations();
        if (cancelled) return;
        setConversations(rows.map(apiConvToLocal));
      } catch (error) {
        console.warn('Conversations fetch failed:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, isAuthReady]);

  // In-memory message cache. Keyed by conversation id. Holds the
  // most-recently-fetched message list for a conversation so a click on
  // the sidebar can render immediately without waiting on the network.
  //
  // The cache is intentionally in-process only — we never persist message
  // contents because they may include clinical / PHI-adjacent content.
  //
  // `inflight` tracks in-flight prefetches so a click can't trigger a
  // duplicate request if the prefetch is still resolving.
  const messagesCacheRef = useRef<Map<string, Message[]>>(new Map());
  const inflightMessagesRef = useRef<Map<string, Promise<Message[]>>>(new Map());

  // Reset cache whenever the authed user changes (login / logout / switch).
  useEffect(() => {
    messagesCacheRef.current.clear();
    inflightMessagesRef.current.clear();
  }, [user?.uid]);

  const fetchMessagesForConversation = useCallback(async (id: string): Promise<Message[]> => {
    const cached = messagesCacheRef.current.get(id);
    if (cached) return cached;
    const inflight = inflightMessagesRef.current.get(id);
    if (inflight) return inflight;
    const promise = (async () => {
      try {
        const { messages: rows } = await listMessages(id);
        return rows.map(apiMsgToLocal);
      } finally {
        inflightMessagesRef.current.delete(id);
      }
    })();
    inflightMessagesRef.current.set(id, promise);
    const all = await promise;
    messagesCacheRef.current.set(id, all);
    return all;
  }, []);

  // First three normal conversations in current sidebar order. We slice
  // after filtering so we match what SidebarHistory actually renders.
  const prefetchIds = useMemo(() => {
    const normals = conversations.filter((c) => c.type !== 'dual' && c.type !== 'compare');
    return normals.slice(0, 3).map((c) => c.id);
  }, [conversations]);

  // Prefetch the first three normal conversations as soon as the
  // conversation list is available. Each conversation is fetched
  // independently; a failure on one does not block the others.
  useEffect(() => {
    if (!isAuthReady || !user) return;
    if (prefetchIds.length === 0) return;

    let cancelled = false;
    (async () => {
      await Promise.all(
        prefetchIds.map(async (id) => {
          if (messagesCacheRef.current.has(id)) return;
          try {
            const all = await fetchMessagesForConversation(id);
            if (cancelled) return;
            // Only store if we still care about it (the conversation may
            // have been deleted or pushed out of the top three).
            if (!prefetchIds.includes(id)) {
              messagesCacheRef.current.delete(id);
              return;
            }
            messagesCacheRef.current.set(id, all);
          } catch (err) {
            if (!cancelled) {
              console.warn('Prefetch messages failed for', id, err);
            }
          }
        })
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [prefetchIds, fetchMessagesForConversation, isAuthReady, user]);

  const activeConversation = conversations.find(c => c.id === activeConversationId) || null;

  // Drop a cached conversation's messages so the next fetch returns the
  // fresh state. Called after writes that mutate message history.
  const invalidateMessagesCache = useCallback((id: string) => {
    messagesCacheRef.current.delete(id);
    inflightMessagesRef.current.delete(id);
  }, []);

  // Refresh a single conversation (used after writes).
  const refreshConversation = useCallback(async (id: string) => {
    try {
      const { conversations: all } = await listConversations();
      setConversations(all.map(apiConvToLocal));
      void id;
    } catch (error) {
      console.warn('refreshConversation failed:', error);
    }
  }, []);

  // Handle conversation selection.
  const handleSelectConversation = async (id: string) => {
    setMessages([]);
    setDualMessages({ primary: [], secondary: [] });
    setDualLoading({ primary: false, secondary: false });
    setCompareMessages({ basic: [], condensed: [] });
    setCompareLoading({ basic: false, condensed: false });
    setCurrentPhase(null);
    setCurrentStep(null);
    setLastDetectedPhase(null);
    setActiveConversationId(id);
    setIsSidebarOpen(false);

    const convType = conversations.find((c) => c.id === id)?.type ?? 'normal';
    // Surface a centered spinner for compare conversations while we wait
    // on the database. Normal / dual paths don't need this — their
    // existing "Welcome" / "Waiting for input" copy is fine for an empty
    // chat, but a compare conversation has two empty panes side by side
    // and looks broken without feedback.
    const showCompareLoader = convType === 'compare';
    if (showCompareLoader) setIsFetchingCompareMessages(true);

    // For normal conversations, only show the loader if the messages
    // aren't already in the prefetch cache. Prefetched conversations
    // resolve inside `fetchMessagesForConversation` synchronously and
    // would otherwise flash the spinner for a single frame.
    const showNormalLoader =
      convType === 'normal' && !messagesCacheRef.current.has(id);
    if (showNormalLoader) setIsFetchingNormalMessages(true);

    // Load messages for the selected conversation and route them to the
    // correct state slot. Normal conversations use `setMessages`; dual
    // conversations route by `lane` (primary/secondary); compare
    // conversations route by `lane` (basic/condensed). Unknown lanes are
    // collected into the single-pane `messages` array as a fallback.
    try {
      const all = await fetchMessagesForConversation(id);

      if (convType === 'dual') {
        const primary = all.filter((m) => m.lane === 'primary');
        const secondary = all.filter((m) => m.lane === 'secondary');
        setDualMessages({ primary, secondary });
      } else if (convType === 'compare') {
        const basic = all.filter((m) => m.lane === 'basic');
        const condensed = all.filter((m) => m.lane === 'condensed');
        setCompareMessages({ basic, condensed });
      } else {
        // Normal conversation: ignore any non-'single' rows that may have
        // been left over from a previous dual/compare run.
        setMessages(all.filter((m) => !m.lane || m.lane === 'single'));
      }
    } catch (error) {
      console.warn('listMessages failed:', error);
    } finally {
      if (showCompareLoader) setIsFetchingCompareMessages(false);
      if (showNormalLoader) setIsFetchingNormalMessages(false);
    }
  };

  const handleNewConversation = () => {
    setActiveConversationId(null);
    setMessages([]);
    setDualMessages({ primary: [], secondary: [] });
    setCompareMessages({ basic: [], condensed: [] });
    setCurrentPhase(null);
    setCurrentStep(null);
    setLastDetectedPhase(null);
    setNewConsultationCount((n) => n + 1);
  };

  // Create a new dual conversation via API.
  const handleNewDualConversation = async () => {
    if (!user) return;
    const primaryProv = promptSettings?.provider || 'harvard';
    // Dual mode now uses Harvard for both lanes.
    const secondaryProv = 'harvard';
    try {
      const { conversation } = await createConversation({
        title: `Dual Mode - ${new Date().toLocaleTimeString()}`,
        type: 'dual',
        primaryProvider: primaryProv,
        secondaryProvider: secondaryProv,
      });
      setDualMessages({ primary: [], secondary: [] });
      setDualLoading({ primary: false, secondary: false });
      setActiveConversationId(conversation.id);
      setMessages([]);
      setCurrentPhase(null);
      setCurrentStep(null);
      setLastDetectedPhase(null);
      setNewConsultationCount((n) => n + 1);
      setIsSidebarOpen(false);
      setConversations(prev => [apiConvToLocal(conversation), ...prev]);
    } catch (error) {
      console.warn('Failed to create dual conversation:', error);
    }
  };

  // Create a new compare conversation via API.
  const handleNewCompareConversation = async () => {
    if (!user) return;
    try {
      const { conversation } = await createConversation({
        title: `Compare Mode - ${new Date().toLocaleTimeString()}`,
        type: 'compare',
      });
      setCompareMessages({ basic: [], condensed: [] });
      setCompareLoading({ basic: false, condensed: false });
      setActiveConversationId(conversation.id);
      setMessages([]);
      setCurrentPhase(null);
      setCurrentStep(null);
      setLastDetectedPhase(null);
      setNewConsultationCount((n) => n + 1);
      setIsSidebarOpen(false);
      setConversations(prev => [apiConvToLocal(conversation), ...prev]);
    } catch (error) {
      console.warn('Failed to create compare conversation:', error);
    }
  };

  const handleDeleteConversation = async (id: string) => {
    try {
      await deleteConversation(id);
      setConversations(prev => prev.filter(c => c.id !== id));
      messagesCacheRef.current.delete(id);
      if (activeConversationId === id) handleNewConversation();
    } catch (error) {
      console.warn('Failed to delete conversation:', error);
    }
  };

  const handleSendMessage = async (content: string) => {
    if (!user) return;
    setIsLoading(true);

    try {
      let convId = activeConversationId;

      // Create new conversation if none active.
      if (!convId) {
        const title = content.length > 40 ? content.substring(0, 40) + '...' : content;
        try {
          const { conversation } = await createConversation({ title, type: 'normal' });
          convId = conversation.id;
          setConversations(prev => [apiConvToLocal(conversation), ...prev]);
        } catch (err) {
          console.warn('Failed to create conversation:', err);
          setIsLoading(false);
          return;
        }
        setActiveConversationId(convId);
      }
      // Optimistic user message in local state so the UI flips immediately.
      const localUserId = `local-user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setMessages(prev => [...prev, {
        id: localUserId,
        role: 'user',
        content,
        createdAt: new Date(),
      }]);

      // Persist user message via API (idempotent via clientId).
      let persistedUserId: string = localUserId;
      try {
        const { message } = await appendMessage(convId, {
          role: 'user',
          content,
          clientId: localUserId,
        });
        persistedUserId = message.id;
        invalidateMessagesCache(convId);
      } catch (err) {
        console.warn('Failed to persist user message:', err);
      }
      let finalContent: string;
      let isInsufficientInfo: boolean = false;
      let detectedPhase: PhaseName | null = null;
      let detectedStep: string | null = null;

      const currentMessages = messages.map(m => ({ role: m.role, content: m.content }));

      let detectedTemplate: ResponsePath = 'assess_template_1_or_3';

      const savedResponseMode = typeof window !== 'undefined'
        ? (localStorage.getItem('responseMode') || 'basic')
        : 'basic';
      const localResponseMode = savedResponseMode as 'basic' | 'condensed';

      try {
        const result: GenerationResult = await generateClinicalResponseWithHistory(
          content,
          currentMessages,
          effectivePhase,
          undefined,
          localResponseMode,
        );
        finalContent = result.response;
        detectedTemplate = result.template;
        isInsufficientInfo = isInsufficientInfoResponse(finalContent);

        if (!isInsufficientInfo) {
          const inferred = parseFrameworkPosition(finalContent);
          detectedPhase = inferred.phase;
          detectedStep = inferred.step;
        }
        updateTemplate(detectedTemplate, true);
      } catch (err) {
        console.warn('LLM generation failed:', err);
        finalContent = 'Sorry, I had trouble generating a response. Please try again.';
      }

      // Optimistic assistant message in local state.
      const localAssistantId = `local-assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setMessages(prev => [...prev, {
        id: localAssistantId,
        role: 'assistant',
        content: finalContent,
        createdAt: new Date(),
        isInsufficientInfo,
      }]);

      // Persist assistant message via API.
      try {
        const { message } = await appendMessage(convId, {
          role: 'assistant',
          content: finalContent,
          isInsufficientInfo,
          clientId: localAssistantId,
        });
        void message;
        invalidateMessagesCache(convId);
      } catch (err) {
        console.warn('Failed to persist assistant message:', err);
      }
      // Update framework state via API (best-effort).
      const nextPhase = currentPhase ?? detectedPhase ?? lastDetectedPhase ?? null;
      const nextStep = currentStep ?? detectedStep ?? null;
      const nextDetectedPhase = detectedPhase ?? lastDetectedPhase ?? currentPhase ?? null;
      try {
        await patchConversation(convId, {
          currentPhase: nextPhase,
          currentStep: nextStep,
          lastDetectedPhase: nextDetectedPhase,
        });
        if (nextPhase) setCurrentPhase(nextPhase);
        if (nextStep) setCurrentStep(nextStep);
        if (nextDetectedPhase) setLastDetectedPhase(nextDetectedPhase);
        // Bump the conversation in the sidebar by re-fetching.
        void refreshConversation(convId);
      } catch (err) {
        console.warn('Failed to update framework state:', err);
      }
    } catch (error) {
      console.error('Error sending message:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDualSendMessage = async (content: string) => {
    if (!user || !activeConversationId) return;
    const convId = activeConversationId;
    const userClientIdPrimary = `local-user-${Date.now()}-${Math.random().toString(36).slice(2)}-primary`;
    const userClientIdSecondary = `local-user-${Date.now()}-${Math.random().toString(36).slice(2)}-secondary`;
    const userMsgPrimary: Message = {
      id: userClientIdPrimary,
      role: 'user',
      content,
      createdAt: new Date(),
      lane: 'primary',
    };
    const userMsgSecondary: Message = {
      id: userClientIdSecondary,
      role: 'user',
      content,
      createdAt: new Date(),
      lane: 'secondary',
    };
    setDualMessages(prev => ({
      primary: [...prev.primary, userMsgPrimary],
      secondary: [...prev.secondary, userMsgSecondary],
    }));
    setDualLoading({ primary: true, secondary: true });

    // Persist the user message on both lanes (one row per lane, same content).
    try {
      await Promise.all([
        appendMessage(convId, {
          role: 'user',
          content,
          clientId: userClientIdPrimary,
          lane: 'primary',
        }),
        appendMessage(convId, {
          role: 'user',
          content,
          clientId: userClientIdSecondary,
          lane: 'secondary',
        }),
      ]);
      invalidateMessagesCache(convId);
    } catch (err) {
      console.warn('Failed to persist dual user message:', err);
    }
    try {
      const [primaryResponse, secondaryResponse] = await Promise.allSettled([
        generateClinicalResponseWithHistory(content, [], null, 'harvard', 'basic'),
        generateClinicalResponseWithHistory(content, [], null, 'harvard', 'condensed'),
      ]);

      const primaryAssistantId = `local-assistant-${Date.now()}-${Math.random().toString(36).slice(2)}-primary`;
      if (primaryResponse.status === 'fulfilled') {
        setDualMessages(prev => ({
          ...prev,
          primary: [...prev.primary, {
            id: primaryAssistantId,
            role: 'assistant',
            content: primaryResponse.value.response,
            createdAt: new Date(),
            lane: 'primary',
          }],
        }));
        try {
          await appendMessage(convId, {
            role: 'assistant',
            content: primaryResponse.value.response,
            isInsufficientInfo: false,
            clientId: primaryAssistantId,
            lane: 'primary',
          });
          invalidateMessagesCache(convId);
        } catch (err) {
          console.warn('Failed to persist dual primary assistant message:', err);
        }
      } else {
        const errorMsg = `Error: ${primaryResponse.reason?.message || 'Failed to get primary response'}`;
        const errorId = `local-error-${Date.now()}-${Math.random().toString(36).slice(2)}-primary`;
        setDualMessages(prev => ({
          ...prev,
          primary: [...prev.primary, {
            id: errorId,
            role: 'assistant',
            content: errorMsg,
            createdAt: new Date(),
            lane: 'primary',
          }],
        }));
        // Errors are intentionally NOT persisted so they don't pollute history.
      }
      setDualLoading(prev => ({ ...prev, primary: false }));

      const secondaryAssistantId = `local-assistant-${Date.now()}-${Math.random().toString(36).slice(2)}-secondary`;
      if (secondaryResponse.status === 'fulfilled') {
        setDualMessages(prev => ({
          ...prev,
          secondary: [...prev.secondary, {
            id: secondaryAssistantId,
            role: 'assistant',
            content: secondaryResponse.value.response,
            createdAt: new Date(),
            lane: 'secondary',
          }],
        }));
        try {
          await appendMessage(convId, {
            role: 'assistant',
            content: secondaryResponse.value.response,
            isInsufficientInfo: false,
            clientId: secondaryAssistantId,
            lane: 'secondary',
          });
          invalidateMessagesCache(convId);
        } catch (err) {
          console.warn('Failed to persist dual secondary assistant message:', err);
        }
      } else {
        const errorMsg = `Error: ${secondaryResponse.reason?.message || 'Failed to get secondary response'}`;
        const errorId = `local-error-${Date.now()}-${Math.random().toString(36).slice(2)}-secondary`;
        setDualMessages(prev => ({
          ...prev,
          secondary: [...prev.secondary, {
            id: errorId,
            role: 'assistant',
            content: errorMsg,
            createdAt: new Date(),
            lane: 'secondary',
          }],
        }));
        // Errors are intentionally NOT persisted.
      }
      setDualLoading(prev => ({ ...prev, secondary: false }));

      // Bump the conversation in the sidebar.
      void refreshConversation(convId);
    } catch (error) {
      console.error('Error in dual mode:', error);
      setDualLoading({ primary: false, secondary: false });
    }
  };

  const handleCompareSendMessage = async (content: string) => {
    if (!user || !activeConversationId) return;
    const convId = activeConversationId;
    const userClientIdBasic = `local-user-${Date.now()}-${Math.random().toString(36).slice(2)}-basic`;
    const userClientIdCondensed = `local-user-${Date.now()}-${Math.random().toString(36).slice(2)}-condensed`;
    const userMsgBasic: Message = {
      id: userClientIdBasic,
      role: 'user',
      content,
      createdAt: new Date(),
      lane: 'basic',
    };
    const userMsgCondensed: Message = {
      id: userClientIdCondensed,
      role: 'user',
      content,
      createdAt: new Date(),
      lane: 'condensed',
    };
    setCompareMessages(prev => ({
      basic: [...prev.basic, userMsgBasic],
      condensed: [...prev.condensed, userMsgCondensed],
    }));
    setCompareLoading({ basic: true, condensed: true });

    // Persist the user message on both lanes (one row per lane, same content).
    try {
      await Promise.all([
        appendMessage(convId, {
          role: 'user',
          content,
          clientId: userClientIdBasic,
          lane: 'basic',
        }),
        appendMessage(convId, {
          role: 'user',
          content,
          clientId: userClientIdCondensed,
          lane: 'condensed',
        }),
      ]);
      invalidateMessagesCache(convId);
    } catch (err) {
      console.warn('Failed to persist compare user message:', err);
    }
    try {
      const [basicResponse, condensedResponse] = await Promise.allSettled([
        generateClinicalResponseWithHistory(content, [], null, 'harvard', 'basic'),
        generateClinicalResponseWithHistory(content, [], null, 'harvard', 'condensed'),
      ]);

      const basicAssistantId = `local-assistant-${Date.now()}-${Math.random().toString(36).slice(2)}-basic`;
      if (basicResponse.status === 'fulfilled') {
        setCompareMessages(prev => ({
          ...prev,
          basic: [...prev.basic, {
            id: basicAssistantId,
            role: 'assistant',
            content: basicResponse.value.response,
            createdAt: new Date(),
            lane: 'basic',
          }],
        }));
        try {
          await appendMessage(convId, {
            role: 'assistant',
            content: basicResponse.value.response,
            isInsufficientInfo: false,
            clientId: basicAssistantId,
            lane: 'basic',
          });
          invalidateMessagesCache(convId);
        } catch (err) {
          console.warn('Failed to persist compare basic assistant message:', err);
        }
      } else {
        const errorMsg = `Error: ${basicResponse.reason?.message || 'Failed to get basic response'}`;
        const errorId = `local-error-${Date.now()}-${Math.random().toString(36).slice(2)}-basic`;
        setCompareMessages(prev => ({
          ...prev,
          basic: [...prev.basic, {
            id: errorId,
            role: 'assistant',
            content: errorMsg,
            createdAt: new Date(),
            lane: 'basic',
          }],
        }));
        // Errors are intentionally NOT persisted.
      }
      setCompareLoading(prev => ({ ...prev, basic: false }));

      const condensedAssistantId = `local-assistant-${Date.now()}-${Math.random().toString(36).slice(2)}-condensed`;
      if (condensedResponse.status === 'fulfilled') {
        setCompareMessages(prev => ({
          ...prev,
          condensed: [...prev.condensed, {
            id: condensedAssistantId,
            role: 'assistant',
            content: condensedResponse.value.response,
            createdAt: new Date(),
            lane: 'condensed',
          }],
        }));
        try {
          await appendMessage(convId, {
            role: 'assistant',
            content: condensedResponse.value.response,
            isInsufficientInfo: false,
            clientId: condensedAssistantId,
            lane: 'condensed',
          });
          invalidateMessagesCache(convId);
        } catch (err) {
          console.warn('Failed to persist compare condensed assistant message:', err);
        }
      } else {
        const errorMsg = `Error: ${condensedResponse.reason?.message || 'Failed to get condensed response'}`;
        const errorId = `local-error-${Date.now()}-${Math.random().toString(36).slice(2)}-condensed`;
        setCompareMessages(prev => ({
          ...prev,
          condensed: [...prev.condensed, {
            id: errorId,
            role: 'assistant',
            content: errorMsg,
            createdAt: new Date(),
            lane: 'condensed',
          }],
        }));
        // Errors are intentionally NOT persisted.
      }
      setCompareLoading(prev => ({ ...prev, condensed: false }));

      // Bump the conversation in the sidebar.
      void refreshConversation(convId);
    } catch (error) {
      console.error('Error in compare mode:', error);
      setCompareLoading({ basic: false, condensed: false });
    }
  };

  const isDualMode = activeConversation?.type === 'dual';
  const isCompareMode = activeConversation?.type === 'compare';
  const primaryProvider = activeConversation?.primaryProvider || promptSettings?.provider || 'harvard';
  // Both lanes in dual mode now use Harvard. Kept as a separate variable so
  // existing call sites that read `secondaryProvider` still compile.
  const secondaryProvider = activeConversation?.secondaryProvider || 'harvard';

  const latestAssistantMessage = [...messages].reverse().find((m) => m.role === 'assistant') || null;
  const inferredFromOutput = latestAssistantMessage
    ? parseFrameworkPosition(latestAssistantMessage.content)
    : { phase: null, step: null };
  const effectivePhase: PhaseName | null =
    currentPhase || lastDetectedPhase || inferredFromOutput.phase || null;
  const effectiveStep: string | null = currentStep || inferredFromOutput.step || null;
  const effectiveDetectedPhase: PhaseName | null =
    lastDetectedPhase || currentPhase || inferredFromOutput.phase || null;

  const handleSelectPhase = async (phase: PhaseName) => {
    setCurrentPhase(phase);
    setCurrentStep(null);
    if (activeConversationId) {
      try {
        await patchConversation(activeConversationId, {
          currentPhase: phase,
          currentStep: null,
          lastDetectedPhase,
        });
        void refreshConversation(activeConversationId);
      } catch (err) {
        console.warn('patchConversation failed:', err);
      }
    }
  };

  const handleSelectStep = async (step: string) => {
    const phaseForStep = findPhaseForStep(step);
    setCurrentStep(step);
    if (activeConversationId) {
      try {
        await patchConversation(activeConversationId, {
          currentPhase: phaseForStep || currentPhase,
          currentStep: step,
          lastDetectedPhase,
        });
        void refreshConversation(activeConversationId);
      } catch (err) {
        console.warn('patchConversation failed:', err);
      }
    }
  };

  const handleEmailSignIn = async (email: string, password: string) => {
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    setLoginError(null);
    try {
      await authClient.signIn.email({ email, password });
    } catch (error) {
      setLoginError('Invalid email or password.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleEmailSignUp = async (email: string, password: string, name: string) => {
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    setLoginError(null);
    try {
      await authClient.signUp.email({ email, password, name });
    } catch (error) {
      setLoginError('Could not create account. Email may already be in use.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <LoginScreen
        onEmailSignIn={handleEmailSignIn}
        onEmailSignUp={handleEmailSignUp}
        isLoading={isLoggingIn}
        error={loginError}
      />
    );
  }

  return (
    <div className="flex h-screen w-full bg-white dark:bg-zinc-950">
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 md:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}
      <div
        className={cn(
          'fixed md:relative z-50 h-full transition-transform duration-300',
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        )}
      >
        <SidebarHistory
          conversations={conversations}
          activeId={activeConversationId}
          onSelect={handleSelectConversation}
          onNew={handleNewConversation}
          onNewDual={handleNewDualConversation}
          onNewCompare={handleNewCompareConversation}
          onDelete={handleDeleteConversation}
          onLogout={() => void authClient.signOut()}
          userEmail={user.email ?? ''}
          setShowAdminPanel={setShowAdminPanel}
          setShowSettingsPanel={setShowSettingsPanel}
          onClose={() => setIsSidebarOpen(false)}
        />
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="md:hidden flex items-center justify-between p-4 border-b border-zinc-200 dark:border-zinc-800">
          <button onClick={() => setIsSidebarOpen(true)} className="p-2 -mr-2 text-zinc-600 dark:text-zinc-400">
            <Menu size={24} />
          </button>
        </div>

        {/* In-flow: the map takes its own space above the chat area, so it
            never overlaps the welcome text or the messages. */}
        <div className="shrink-0">
          <NavigationMap
            currentPhase={effectivePhase}
            currentStep={effectiveStep}
            detectedPhase={effectiveDetectedPhase}
            onSelectPhase={handleSelectPhase}
            onSelectStep={handleSelectStep}
            onShowResources={() => setShowResourcesPanel(true)}
            onToggleOpen={(open) => setIsNavMapOpen(open)}
            openSignal={newConsultationCount}
          />
        </div>

        <div className="flex-1 relative min-h-0">
          {isCompareMode ? (
            <>
              <CompareChatView
                primaryMessages={compareMessages.basic}
                secondaryMessages={compareMessages.condensed}
                primaryLoading={compareLoading.basic}
                secondaryLoading={compareLoading.condensed}
                isFetchingHistory={isFetchingCompareMessages}
              />
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-white via-white to-transparent dark:from-zinc-950 dark:via-zinc-950 p-2 md:p-4 pt-8 md:pt-12">
                <CompareInputForm
                  onSendMessage={handleCompareSendMessage}
                  basicLoading={compareLoading.basic}
                  condensedLoading={compareLoading.condensed}
                />
              </div>
            </>
          ) : isDualMode ? (
            <>
              <DualChatView
                primaryMessages={dualMessages.primary}
                secondaryMessages={dualMessages.secondary}
                primaryProvider={primaryProvider}
                secondaryProvider={secondaryProvider}
                primaryLoading={dualLoading.primary}
                secondaryLoading={dualLoading.secondary}
              />
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-white via-white to-transparent dark:from-zinc-950 dark:via-zinc-950 p-2 md:p-4 pt-8 md:pt-12">
                <DualInputForm
                  onSendMessage={handleDualSendMessage}
                  primaryLoading={dualLoading.primary}
                  secondaryLoading={dualLoading.secondary}
                />
              </div>
            </>
          ) : (
            <ChatWindow
              messages={messages}
              onSendMessage={handleSendMessage}
              isLoading={isLoading}
              suggestedPrompts={promptSettings?.suggestedPrompts || DEFAULT_SUGGESTED_PROMPTS}
              provider={primaryProvider}
              isFetchingHistory={isFetchingNormalMessages}
            />
          )}
        </div>
      </div>

      {showAdminPanel && isAdminFromSession(session) && (
        <AdminPanel onClose={() => setShowAdminPanel(false)} />
      )}

      {showSettingsPanel && (
        <SettingsPanel onClose={() => setShowSettingsPanel(false)} />
      )}

      <ResourcesPanel
        isOpen={showResourcesPanel}
        onClose={() => setShowResourcesPanel(false)}
      />

      {currentTemplate && isBadgeVisible && (
        <TemplateDevBadge
          template={currentTemplate}
          tier1Complete={tier1Complete ?? undefined}
          provider={primaryProvider}
        />
      )}
    </div>
  );
}
