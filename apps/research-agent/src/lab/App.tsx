import { useCallback, useMemo, useState } from "react";
import { ResearchFeed } from "./components/ResearchFeed";
import { ChatPanel } from "./components/ChatPanel";
import { IdeasPanel } from "./components/IdeasPanel";
import { useIdeas } from "./hooks/useIdeas";
import { useArticles } from "./hooks/useArticles";
import { useChat } from "./hooks/useChat";
import { NewIdeaModal } from "./components/NewIdeaModal";
import { IdeaDrawer } from "./components/IdeaDrawer";
import { PromoteModal } from "./components/PromoteModal";
import type { Article, ArticleWindow, ChatScope, Idea } from "./types";
import { Beaker, Menu } from "lucide-react";

export function App() {
  const [window, setWindow] = useState<ArticleWindow>("7d");
  const [scope, setScope] = useState<ChatScope>("digest");
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [feedOpen, setFeedOpen] = useState(true);

  // Modal/drawer state
  const [newIdeaInitial, setNewIdeaInitial] = useState<{
    title: string;
    body: string;
    linked_article_ids: string[];
    chat_thread: unknown[];
  } | null>(null);
  const [openIdea, setOpenIdea] = useState<Idea | null>(null);
  const [promotingIdea, setPromotingIdea] = useState<Idea | null>(null);

  // Data
  const ideasH = useIdeas();
  const articlesH = useArticles(window);
  const chatH = useChat();

  const pinnedArticles: Article[] = useMemo(
    () => articlesH.articles.filter((a) => pinnedIds.has(a.id)),
    [articlesH.articles, pinnedIds],
  );

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Trigger "Save as idea" modal pre-populated from a Claude reply.
  const onSaveAsIdea = useCallback((replyText: string) => {
    const firstSentence = replyText.split(/(?<=[.!?])\s+/)[0] || replyText;
    const title = firstSentence.slice(0, 80);
    setNewIdeaInitial({
      title,
      body: replyText,
      linked_article_ids: scope === "selected" || scope === "digest"
        ? Array.from(pinnedIds).slice(0, 12)
        : [],
      chat_thread: chatH.recentThread(),
    });
  }, [chatH, pinnedIds, scope]);

  return (
    <div className="h-screen flex bg-bg-primary text-text-primary overflow-hidden">
      {/* Research Feed (collapsible at < 1200px via Menu button) */}
      {feedOpen && (
        <div className="w-72 flex-none border-r border-border bg-bg-surface hidden lg:flex flex-col">
          <ResearchFeed
            articles={articlesH.articles}
            loading={articlesH.loading}
            window={window}
            onWindowChange={setWindow}
            pinnedIds={pinnedIds}
            onTogglePin={togglePin}
          />
        </div>
      )}
      {/* Chat (center) */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="flex items-center gap-3">
            <button
              className="lg:hidden text-text-muted hover:text-text-primary"
              onClick={() => setFeedOpen((f) => !f)}
              aria-label="Toggle feed"
            >
              <Menu className="w-5 h-5" />
            </button>
            <Beaker className="w-5 h-5 text-accent-primary" />
            <h1 className="font-display text-lg tracking-wide">The Lab</h1>
          </div>
          <a
            href="/lab/logout"
            className="text-xs text-text-muted hover:text-text-primary"
          >
            Sign out
          </a>
        </header>
        <ChatPanel
          scope={scope}
          onScopeChange={setScope}
          pinnedArticles={pinnedArticles}
          turns={chatH.turns}
          loading={chatH.loading}
          onSend={(msg) => chatH.send(msg, scope, pinnedArticles)}
          onCancel={chatH.cancel}
          onSaveAsIdea={onSaveAsIdea}
          onClear={chatH.clear}
        />
      </div>
      {/* Ideas (right) */}
      <div className="w-96 flex-none border-l border-border bg-bg-surface hidden md:flex flex-col">
        <IdeasPanel
          ideas={ideasH.ideas}
          loading={ideasH.loading}
          onNewIdea={() => setNewIdeaInitial({ title: "", body: "", linked_article_ids: [], chat_thread: [] })}
          onAdvance={async (id, status) => { await ideasH.setStatus(id, status); }}
          onOpen={(idea) => setOpenIdea(idea)}
          onPromote={(idea) => setPromotingIdea(idea)}
          onMoveIdea={(id, position) => ideasH.setPosition(id, position)}
        />
      </div>

      {/* Modals + drawer */}
      {newIdeaInitial && (
        <NewIdeaModal
          initial={newIdeaInitial}
          onClose={() => setNewIdeaInitial(null)}
          onCreate={async (input) => {
            await ideasH.add(input);
            setNewIdeaInitial(null);
          }}
        />
      )}
      {openIdea && (
        <IdeaDrawer
          idea={openIdea}
          onClose={() => setOpenIdea(null)}
          onUpdate={async (patch) => {
            const updated = await ideasH.update(openIdea.id, patch);
            setOpenIdea(updated);
          }}
          onDelete={async () => {
            await ideasH.remove(openIdea.id);
            setOpenIdea(null);
          }}
          onPromote={() => {
            setPromotingIdea(openIdea);
          }}
        />
      )}
      {promotingIdea && (
        <PromoteModal
          idea={promotingIdea}
          onClose={() => setPromotingIdea(null)}
          onPromoted={(updated) => {
            ideasH.refresh();
            setPromotingIdea(null);
            if (openIdea?.id === updated.id) setOpenIdea(updated);
          }}
        />
      )}
    </div>
  );
}
