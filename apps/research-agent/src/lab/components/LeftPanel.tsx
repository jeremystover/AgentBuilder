import { useState } from "react";
import { ResearchFeed } from "./ResearchFeed";
import { ChatSessionsList } from "./ChatSessionsList";
import type { Article, ArticleWindow, ChatSession } from "../types";
import type { UseChatSessionsResult } from "../hooks/useChatSessions";
import { Plus } from "lucide-react";

type Tab = "articles" | "chats";

interface Props {
  // Articles tab
  articles: Article[];
  articlesLoading: boolean;
  window: ArticleWindow;
  onWindowChange: (w: ArticleWindow) => void;
  pinnedIds: Set<string>;
  onTogglePin: (id: string) => void;
  onIngest: () => void;

  // Chats tab
  sessions: ChatSession[];
  sessionsLoading: boolean;
  activeSessionId: string | null;
  onOpenSession: (id: string | null) => void;
  sessionHooks: UseChatSessionsResult;
}

export function LeftPanel(props: Props) {
  const [tab, setTab] = useState<Tab>("articles");

  return (
    <>
      <div className="flex border-b border-border">
        <TabBtn label="Articles" active={tab === "articles"} onClick={() => setTab("articles")} />
        <TabBtn label="Chats" active={tab === "chats"} onClick={() => setTab("chats")} count={props.sessions.length} />
      </div>
      {tab === "articles" ? (
        <>
          {/* Slim header just for the +Add ingest button — sits above the feed's own search/window controls. */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-bg-surface/50">
            <span className="font-display text-[10px] uppercase tracking-widest text-text-muted">Research</span>
            <button
              onClick={props.onIngest}
              className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary"
              title="Add a URL or upload a PDF"
            >
              <Plus className="w-3 h-3" /> Add
            </button>
          </div>
          <ResearchFeed
            articles={props.articles}
            loading={props.articlesLoading}
            window={props.window}
            onWindowChange={props.onWindowChange}
            pinnedIds={props.pinnedIds}
            onTogglePin={props.onTogglePin}
          />
        </>
      ) : (
        <ChatSessionsList
          sessions={props.sessions}
          loading={props.sessionsLoading}
          activeId={props.activeSessionId}
          onOpen={props.onOpenSession}
          hooks={props.sessionHooks}
        />
      )}
    </>
  );
}

function TabBtn({ label, active, onClick, count }: { label: string; active: boolean; onClick: () => void; count?: number }) {
  return (
    <button
      onClick={onClick}
      className={[
        "flex-1 px-3 py-2 text-xs font-display uppercase tracking-widest transition-colors",
        active
          ? "text-text-primary border-b-2 border-accent-primary -mb-[1px]"
          : "text-text-muted hover:text-text-primary border-b-2 border-transparent",
      ].join(" ")}
    >
      {label}{count ? <span className="ml-1.5 text-[10px] opacity-70">{count}</span> : null}
    </button>
  );
}
