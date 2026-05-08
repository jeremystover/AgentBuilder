import { Wallet, MessageSquare, Inbox, Building2, Receipt, FileText, Upload, Filter, PiggyBank, Settings } from "lucide-react";
import { useRoute, type RouteId } from "../router";

interface Tab {
  id: RouteId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const TABS: Tab[] = [
  { id: "chat",         label: "Chat",         icon: MessageSquare },
  { id: "review",       label: "Review",       icon: Inbox },
  { id: "accounts",     label: "Accounts",     icon: Building2 },
  { id: "transactions", label: "Transactions", icon: Receipt },
  { id: "reports",      label: "Reports",      icon: FileText },
  { id: "imports",      label: "Imports",      icon: Upload },
  { id: "rules",        label: "Rules",        icon: Filter },
  { id: "budget",       label: "Budget",       icon: PiggyBank },
  { id: "config",       label: "Config",       icon: Settings },
];

export function TopNav() {
  const [route, navigate] = useRoute();
  return (
    <header className="flex items-center justify-between border-b border-border bg-bg-surface px-5 py-2 shrink-0">
      <div className="flex items-center gap-1">
        <div className="flex items-center gap-2 pr-3 mr-2 border-r border-border">
          <Wallet className="w-5 h-5 text-accent-primary" />
          <span className="font-semibold text-text-primary text-base">CFO</span>
        </div>
        <nav className="flex items-center gap-0.5 overflow-x-auto scrollbar-thin">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = tab.id === route;
            return (
              <button
                key={tab.id}
                onClick={() => navigate(tab.id)}
                className={
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap " +
                  (active
                    ? "bg-accent-primary/10 text-accent-primary"
                    : "text-text-muted hover:bg-bg-elevated hover:text-text-primary")
                }
              >
                <Icon className="w-4 h-4" /> {tab.label}
              </button>
            );
          })}
        </nav>
      </div>
      <div className="flex items-center gap-3 text-xs text-text-muted">
        <a href="/legacy" className="hover:text-text-primary">Legacy UI</a>
        <a href="/logout" className="hover:text-text-primary">Sign out</a>
      </div>
    </header>
  );
}
