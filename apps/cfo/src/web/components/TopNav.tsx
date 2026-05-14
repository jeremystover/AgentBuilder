import { BarChart2, Inbox, Receipt, FileText, Calendar, PieChart, Activity, Settings, Database } from "lucide-react";
import { useRoute, type RouteId } from "../router";

interface Tab {
  id: RouteId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const TABS: Tab[] = [
  { id: "gather",       label: "Gather",       icon: Database },
  { id: "review",       label: "Review",       icon: Inbox },
  { id: "transactions", label: "Transactions", icon: Receipt },
  { id: "reporting",    label: "Reporting",    icon: FileText },
  { id: "planning",     label: "Planning",     icon: Calendar },
  { id: "spending",     label: "Spending",     icon: PieChart },
  { id: "scenarios",    label: "Scenarios",    icon: Activity },
  { id: "settings",     label: "Settings",     icon: Settings },
];

export function TopNav() {
  const [route, navigate] = useRoute();
  return (
    <header className="flex items-center justify-between border-b border-border bg-bg-surface px-5 py-2 shrink-0">
      <div className="flex items-center gap-1">
        <div className="flex items-center gap-2 pr-3 mr-2 border-r border-border">
          <BarChart2 className="w-5 h-5 text-accent-primary" />
          <span className="font-semibold text-text-primary text-base">Finances</span>
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
        <a href="/logout" className="hover:text-text-primary">Sign out</a>
      </div>
    </header>
  );
}
