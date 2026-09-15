'use client';

import React, { useEffect, useState } from 'react';
import { cn } from '../lib/utils';
import { ChevronUp, ChevronDown, FolderOpen } from 'lucide-react';

export type PhaseName = 'Recognition' | 'Evaluation' | 'Naming & Diagnosis';

const STEPS = [
  'Open the Conversation',
  'Assess Function',
  'Assess Cognition',
  'Assess Safety',
  'Targeted Exam',
  'Labs and Imaging',
  'Medication Review',
  'Assess and Align Understanding',
  'Apply Diagnosis',
  'Stage Condition',
  'Address Risks and Concerns',
  'Plan Follow-up',
];

// Exact hex colors for phase bars (solid, fully saturated)
const PHASE_BAR_COLOR: Record<string, string> = {
  teal: '#2AA6C4',
  emerald: '#2F9E8F',
  orange: '#F2A93B',
};

const PHASES = [
  {
    name: 'Recognition' as PhaseName,
    subtitle: 'Is there a cognitive problem?',
    color: 'teal',
    start: 0,
    end: 3,
  },
  {
    name: 'Evaluation' as PhaseName,
    subtitle: 'What do we know about the problem?',
    color: 'emerald',
    start: 1,
    end: 7,
  },
  {
    name: 'Naming & Diagnosis' as PhaseName,
    subtitle: 'What do we call the problem?',
    color: 'orange',
    start: 7,
    end: 11,
  },
];

interface NavigationMapProps {
  currentPhase: PhaseName | null;
  currentStep: string | null;
  detectedPhase: PhaseName | null;
  onSelectPhase: (phase: PhaseName) => void;
  onSelectStep: (step: string) => void;
  onShowResources?: () => void;
  onToggleOpen?: (isOpen: boolean) => void;
  /** Change this value (e.g. a counter) to force the map open, used when a new consultation starts. */
  openSignal?: number;
}

const MOBILE_MEDIA_QUERY = '(max-width: 767px)';

function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

export function NavigationMap({
  currentPhase,
  currentStep,
  detectedPhase,
  onSelectPhase,
  onSelectStep,
  onShowResources,
  onToggleOpen,
  openSignal,
}: NavigationMapProps) {
  // Always open when the page loads (desktop); collapsed on phones. Collapsing
  // it lasts only for the current page view: a refresh brings it back
  // (decision 2026-08-19: "map down by default").
  const [isOpen, setIsOpen] = useState<boolean>(() => !isMobileViewport());

  const activePhase = currentPhase || detectedPhase;
  const visiblePhase = detectedPhase || currentPhase;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia(MOBILE_MEDIA_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsOpen(!e.matches);

    if (media.addEventListener) {
      media.addEventListener('change', handler);
      return () => media.removeEventListener('change', handler);
    }
    media.addListener(handler);
    return () => media.removeListener(handler);
  }, []);

  // A new consultation always starts with the map open (desktop).
  useEffect(() => {
    if (openSignal === undefined) return;
    setIsOpen(!isMobileViewport());
  }, [openSignal]);

  useEffect(() => {
    onToggleOpen?.(isOpen);
  }, [isOpen, onToggleOpen]);

  const handleToggle = () => {
    const newValue = !isOpen;
    setIsOpen(newValue);
  };

  const COLS = STEPS.length;

  // The map sits in the page flow (not as an overlay), so when it is open it
  // pushes the welcome screen / chat down instead of covering them. The chat
  // area below is the element that scrolls.
  return (
    <div className="shrink-0 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 shadow-sm">

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-0">
        <button
          onClick={handleToggle}
          className="flex items-center gap-2 text-xs uppercase tracking-widest text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          Clinical Workflow Map
        </button>
        <button
          onClick={onShowResources}
          className="flex items-center gap-1.5 px-2 py-1.5 -mr-1.5 text-zinc-500 hover:text-orange-600 dark:hover:text-orange-400 bg-zinc-100 dark:bg-zinc-800 hover:bg-orange-50 dark:hover:bg-orange-950/30 rounded-md transition-colors"
          title="Resources"
        >
          <FolderOpen size={16} />
          <span className="text-xs font-medium">Resources</span>
        </button>
      </div>

      {!isOpen && visiblePhase && (
        <div className="mx-4 mb-2 rounded-lg border border-orange-200 dark:border-orange-800/60 bg-orange-50/80 dark:bg-orange-950/40 px-3 py-1.5 text-xs text-orange-800 dark:text-orange-200">
          <span className="font-semibold">Current phase:</span> {visiblePhase}
          {currentStep && <span className="ml-1 text-orange-600 dark:text-orange-400">• {currentStep}</span>}
        </div>
      )}

      {/* Detected position indicator - shown when phase is detected */}
      {isOpen && detectedPhase && (
        <div className="mx-4 mb-1 px-3 py-1">
          <div className="flex items-center gap-2">
            <div className={cn(
              "w-2 h-2 rounded-full",
              detectedPhase === 'Recognition' && "bg-teal-500",
              detectedPhase === 'Evaluation' && "bg-emerald-500",
              detectedPhase === 'Naming & Diagnosis' && "bg-orange-500"
            )} />
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              <span className="font-medium text-orange-700 dark:text-orange-300">{detectedPhase}</span>
              {currentStep && <span className="text-orange-500 dark:text-orange-400"> • {currentStep}</span>}
            </span>
          </div>
        </div>
      )}

        <div
          className={cn(
            'overflow-hidden transition-all duration-300',
            isOpen ? 'max-h-[280px] opacity-100' : 'max-h-0 opacity-0'
          )}
        >
          <div className="overflow-x-auto px-4 py-2">

          {/* Main grid with consistent columns */}
          <div
            className="grid gap-y-2"
            style={{ gridTemplateColumns: `140px repeat(${COLS}, minmax(52px, 1fr))` }}
          >

            {/* STEP HEADERS ROW */}
            <div className="h-12" /> {/* Label column spacer */}
            {STEPS.map((step) => (
              <div
                key={step}
                className="flex items-end justify-center h-12 pb-3 overflow-visible"
              >
                <button
                  onClick={() => onSelectStep(step)}
                  className="text-[10px] text-center text-zinc-800 dark:text-zinc-200 font-semibold leading-tight rotate-[-35deg] origin-bottom whitespacenowrap hover:text-orange-500 dark:hover:text-orange-400 transition-colors cursor-pointer"
                  style={{ maxWidth: '52px' }}
                  title={`Select: ${step}`}
                >
                  {step}
                </button>
              </div>
            ))}

            {/* PHASE ROWS */}
            {PHASES.map((phase) => {
              const barColor = PHASE_BAR_COLOR[phase.color];

              return (
                <React.Fragment key={phase.name}>

                  {/* Label cell */}
                  <div
                    onClick={() => onSelectPhase(phase.name)}
                    className="flex flex-col justify-center px-1 cursor-pointer border-l-2"
                    style={{ borderColor: barColor }}
                  >
                    <div className="text-[8px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                      {phase.name}
                    </div>
                    <div
                      className="text-[10px] font-bold leading-tight"
                      style={{ color: barColor }}
                    >
                      {phase.subtitle}
                    </div>
                  </div>

                  {/* Timeline row - each cell has a dot */}
                  {STEPS.map((step, i) => {
                    const inPhase = i >= phase.start && i <= phase.end;
                    const isStepActive = currentStep === step;
                    const isFirst = i === phase.start;
                    const isLast = i === phase.end;

                    return (
                      <div
                        key={step}
                        className="relative flex items-center justify-center h-7"
                      >
                        {/* Pill bar segment - only first/last have rounded ends */}
                        {inPhase && (
                          <div
                            className={cn(
                              "absolute h-6",
                              isFirst && "rounded-l-full",
                              isLast && "rounded-r-full",
                            )}
                            style={{
                              backgroundColor: barColor,
                              left: '0',
                              right: '0',
                            }}
                          />
                        )}

                        {/* Dot */}
                        {inPhase && (
                          <button
                            onClick={() => onSelectStep(step)}
                            className={cn(
                              "w-3 h-3 rounded-full transition z-10 border",
                              isStepActive
                                ? "bg-orange-400 scale-110 shadow-sm"
                                : "bg-white hover:scale-110 border-2",
                            )}
                            style={{
                              borderColor: isStepActive ? '#F59E0B' : barColor,
                              borderWidth: isStepActive ? '1.5px' : '2px',
                            }}
                            title={step}
                          />
                        )}
                      </div>
                    );
                  })}
                </React.Fragment>
              );
            })}

          </div>
        </div>
      </div>
    </div>
  );
}
