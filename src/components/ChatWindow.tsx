'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader2, AlertTriangle, Minimize2, AlignLeft } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { anonymize } from '../lib/anonymizer';

type ResponseMode = 'basic' | 'condensed';

const RESPONSE_MODE_KEY = 'responseMode';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isInsufficientInfo?: boolean;
}

import { DEFAULT_SUGGESTED_PROMPTS } from '../lib/promptSettings';

interface ChatWindowProps {
  messages: Message[];
  onSendMessage: (content: string) => void;
  isLoading: boolean;
  suggestedPrompts?: string[];
  provider?: string;
  responseMode?: ResponseMode;
  onResponseModeChange?: (mode: ResponseMode) => void;
  /**
   * True while the parent is fetching this conversation's message history
   * from the database. When set, the empty-state "Welcome" copy is
   * swapped for a centered spinner so the user has feedback during the
   * fetch. The input form below remains interactive.
   */
  isFetchingHistory?: boolean;
}

export function ChatWindow({
  messages,
  onSendMessage,
  isLoading,
  suggestedPrompts = DEFAULT_SUGGESTED_PROMPTS,
  provider = 'harvard',
  isFetchingHistory = false,
}: ChatWindowProps) {
  const [input, setInput] = useState('');
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [responseMode, setResponseMode] = useState<ResponseMode>(() => {
    // Load from localStorage or default to 'basic'
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(RESPONSE_MODE_KEY);
      return (saved === 'condensed' ? 'condensed' : 'basic') as ResponseMode;
    }
    return 'basic';
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const prevMessageCountRef = useRef(0);

  // Check if this is a new session (no messages yet)
  const isNewSession = messages.length === 0;

  // Toggle response mode and persist
  const toggleResponseMode = () => {
    const newMode = responseMode === 'basic' ? 'condensed' : 'basic';
    setResponseMode(newMode);
    if (typeof window !== 'undefined') {
      localStorage.setItem(RESPONSE_MODE_KEY, newMode);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Scroll rules (task list 2026-09-04, Nora & Umila):
  // - when a NEW coach response arrives, scroll so its START is at the top of
  //   the view, so the clinician reads from the beginning instead of having
  //   to scroll back up;
  // - when the clinician sends a message or the coach is still thinking,
  //   follow to the bottom as before;
  // - when a whole conversation is loaded from history, jump to the bottom.
  // Decide purely on what was added to the list. (The coach reply is appended
  // while `isLoading` is still true and only clears after the reply has been
  // persisted, so the loading flag must not gate this.)
  useEffect(() => {
    const prevCount = prevMessageCountRef.current;
    const count = messages.length;
    prevMessageCountRef.current = count;

    if (count === 0 || count === prevCount) return; // nothing new: don't move the view
    const last = messages[count - 1];

    if (prevCount === 0 && count > 1) {
      scrollToBottom(); // a whole conversation loaded from history
      return;
    }
    if (last.role === 'assistant') {
      lastMessageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    scrollToBottom(); // the clinician's own message
  }, [messages]);

  // While the coach is thinking, keep the indicator in view.
  useEffect(() => {
    if (isLoading) scrollToBottom();
  }, [isLoading]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const cleanInput = anonymize(input);
    onSendMessage(cleanInput);
    setInput('');
  };

  const handleSuggestedPrompt = (prompt: string) => {
    if (isLoading) return;
    onSendMessage(prompt);
  };

  // Display name for provider (Harvard is the sole supported provider after
  // the MiniMax removal).
  const providerDisplayName = 'Harvard GPT (OpenAI)';

  return (
    <div className="flex flex-col h-full bg-white dark:bg-zinc-950">
      <div className="flex-1 overflow-y-auto relative z-0">
        {messages.length === 0 ? (
          <div className="min-h-full flex flex-col justify-center items-center px-4 md:px-8 py-6 md:py-10">
            {/* Centered loader while the database is being fetched.
                Replaces the welcome copy; the input form and prompts
                below remain visible and interactive. */}
            {isFetchingHistory ? (
              <div
                role="status"
                aria-live="polite"
                aria-label="Loading conversation"
                className="flex flex-col items-center gap-3 px-6 py-5 mb-8 rounded-2xl bg-white/80 dark:bg-zinc-900/80 shadow-sm border border-zinc-200 dark:border-zinc-800"
              >
                <Loader2
                  size={40}
                  className="animate-spin text-orange-500 dark:text-orange-400"
                />
                <div className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                  Loading conversation…
                </div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  Fetching message history from the database
                </div>
              </div>
            ) : (
              <>
                {/* Intro text */}
                <div className="max-w-3xl mx-auto text-center mb-8">
                  <h1 className="text-2xl md:text-3xl font-semibold text-zinc-700 dark:text-zinc-200 leading-tight">
                    Welcome to the Cognitive Care Coach
                  </h1>
                  <p className="text-base md:text-lg text-zinc-500 dark:text-zinc-400 leading-relaxed mt-3">
                    Practical communication support for primary care conversations about cognitive health, memory concerns, and dementia.
                  </p>
                </div>
              </>
            )}
            
            {/* Prompt window - standalone input */}
            <div className="w-full max-w-3xl mb-4">
              <div className={[
                "bg-white dark:bg-zinc-900 rounded-2xl shadow-sm transition-all border-2",
                !isInputFocused
                  ? "border-orange-500 animate-pulse-border"
                  : "border-orange-500"
              ].join(" ")}>
                <form
                  onSubmit={handleSubmit}
                  className="relative flex items-center"
                >
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onFocus={() => setIsInputFocused(true)}
                    onBlur={() => setIsInputFocused(false)}
                    placeholder="Ask the coach…"
                    className={`w-full bg-transparent py-3 md:py-4 pl-4 md:pl-6 pr-12 md:pr-14 outline-none text-sm md:text-base text-zinc-800 dark:text-zinc-200 ${!isInputFocused ? 'placeholder:text-zinc-400 animate-pulse-text' : 'placeholder:text-zinc-400'}`}
                    disabled={isLoading}
                  />
                  <button
                    type="submit"
                    disabled={!input.trim() || isLoading}
                    className="absolute right-2 p-1.5 md:p-2 rounded-xl bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50 disabled:hover:bg-orange-500 transition-colors"
                  >
                    <Send size={16} />
                  </button>
                </form>
              </div>
            </div>
            
            {/* Prompt template pairs - each line has 2 prompts fitting content width */}
            <div className="flex flex-col items-center gap-3">
              {Array.from({ length: Math.ceil(suggestedPrompts.length / 2) }).map((_, rowIndex) => {
                const prompt1 = suggestedPrompts[rowIndex * 2];
                const prompt2 = suggestedPrompts[rowIndex * 2 + 1];
                return (
                  <div key={`pair-${rowIndex}`} className="flex gap-3">
                    <button
                      onClick={() => handleSuggestedPrompt(prompt1)}
                      className="shrink-0 text-left px-4 py-3 rounded-xl bg-zinc-100 dark:bg-zinc-800/50 text-zinc-700 dark:text-zinc-200 text-sm hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors border border-zinc-200 dark:border-zinc-700 whitespace-nowrap"
                      disabled={isLoading}
                    >
                      {prompt1}
                    </button>
                    {prompt2 ? (
                      <button
                        onClick={() => handleSuggestedPrompt(prompt2)}
                        className="shrink-0 text-left px-4 py-3 rounded-xl bg-zinc-100 dark:bg-zinc-800/50 text-zinc-700 dark:text-zinc-200 text-sm hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors border border-zinc-200 dark:border-zinc-700 whitespace-nowrap"
                        disabled={isLoading}
                      >
                        {prompt2}
                      </button>
                    ) : (
                      <div className="shrink-0 w-[200px]" />
                    )}
                  </div>
                );
              })}
            </div>
            
            {/* PHI Warning */}
            <div className="flex justify-center mt-6">
              <div className="inline-flex items-center gap-2 text-[10px] md:text-xs text-amber-600 dark:text-amber-500 bg-amber-50 dark:bg-amber-950/30 py-1.5 px-3 rounded-full border border-amber-200 dark:border-amber-900/50">
                <AlertTriangle size={12} className="shrink-0" />
                <span>Do not input identifiable patient data (PHI). Inputs are anonymized.</span>
              </div>
            </div>

            {/* Response Mode Toggle - always visible */}
            <div className="flex justify-center mt-4">
              <button
                onClick={toggleResponseMode}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-all ${
                  responseMode === 'condensed'
                    ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-700'
                }`}
                title={responseMode === 'condensed' ? 'Switch to Basic mode' : 'Switch to Condensed mode'}
              >
                {responseMode === 'condensed' ? (
                  <>
                    <Minimize2 size={14} />
                    <span className="font-medium">Condensed</span>
                    <span className="text-zinc-400">/ Basic</span>
                  </>
                ) : (
                  <>
                    <AlignLeft size={14} />
                    <span>Basic</span>
                    <span className="text-zinc-400">/ Condensed</span>
                  </>
                )}
              </button>
            </div>
          </div>
        ) : (
          <div className="pt-4 md:pt-6 pb-24 md:pb-28">
            {messages.map((msg, index) => (
              <div
                key={msg.id}
                ref={index === messages.length - 1 ? lastMessageRef : undefined}
                className="scroll-mt-2"
              >
                <MessageBubble role={msg.role} content={msg.content} isInsufficientInfo={msg.isInsufficientInfo} />
              </div>
            ))}
            {isLoading && (
              <div className="flex w-full py-4 md:py-6 bg-zinc-50 dark:bg-zinc-900">
                <div className="max-w-3xl mx-auto flex gap-4 md:gap-6 w-full px-4">
                  <div className="shrink-0 mt-1">
                    <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400">
                      <Loader2 size={18} className="animate-spin" />
                    </div>
                  </div>
                  <div className="flex-1 space-y-2">
                    <div className="font-semibold text-sm text-zinc-800 dark:text-zinc-200">
                      Clinical Coach
                    </div>
                    <div className="text-zinc-500 dark:text-zinc-400 text-sm">
                      Analyzing and retrieving evidence...
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {messages.length > 0 && (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-white via-white to-transparent dark:from-zinc-950 dark:via-zinc-950 p-2 md:p-4 pt-6 md:pt-10">
          <div className="max-w-3xl mx-auto">
            <form
              onSubmit={handleSubmit}
              className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3"
            >
              <div className={[
                "relative flex flex-1 items-center min-w-0 bg-white dark:bg-zinc-900 rounded-2xl shadow-sm transition-all",
                isNewSession && !isInputFocused
                  ? "border-2 border-orange-500 animate-pulse-border"
                  : isNewSession && isInputFocused
                    ? "border-2 border-orange-500"
                    : "border border-zinc-300 dark:border-zinc-700 focus-within:ring-2 focus-within:ring-orange-500/20 focus-within:border-orange-500"
              ].join(" ")}>
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onFocus={() => setIsInputFocused(true)}
                  onBlur={() => setIsInputFocused(false)}
                  placeholder="Ask the coach…"
                  className="w-full bg-transparent py-3 md:py-4 pl-4 md:pl-6 pr-12 md:pr-14 outline-none text-sm md:text-base text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400"
                  disabled={isLoading}
                />
                <button
                  type="submit"
                  disabled={!input.trim() || isLoading}
                  className="absolute right-1.5 md:right-2 p-1.5 md:p-2 rounded-xl bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50 disabled:hover:bg-orange-500 transition-colors"
                >
                  <Send size={16} className="md:w-[18px] md:h-[18px]" />
                </button>
              </div>
            </form>
            <div className="flex items-center justify-between mt-1.5 md:mt-2 px-1">
              {/* Response mode toggle */}
              <button
                onClick={toggleResponseMode}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] transition-all ${
                  responseMode === 'condensed'
                    ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700'
                    : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
                title={responseMode === 'condensed' ? 'Switch to Basic mode' : 'Switch to Condensed mode'}
              >
                {responseMode === 'condensed' ? (
                  <>
                    <Minimize2 size={12} />
                    <span className="font-medium">Condensed</span>
                  </>
                ) : (
                  <>
                    <AlignLeft size={12} />
                    <span>Basic</span>
                  </>
                )}
              </button>
              
              <span className="text-[10px] text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">
                {providerDisplayName}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
