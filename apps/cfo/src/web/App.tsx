import { useEffect, useState } from "react";
import { TopNav } from "./components/TopNav";
import { PlaceholderView } from "./components/PlaceholderView";
import { GatherView } from "./components/drilldowns/GatherView";
import { ReviewQueueView } from "./components/drilldowns/ReviewQueueView";
import { ReviewSwipeView } from "./components/drilldowns/ReviewSwipeView";
import { TransactionsView } from "./components/drilldowns/TransactionsView";
import { ReportsView } from "./components/drilldowns/ReportsView";
import { SpendingView } from "./components/drilldowns/SpendingView";
import { PlansView } from "./components/drilldowns/PlansView";
import { ScenariosView } from "./components/drilldowns/ScenariosView";
import { useRoute } from "./router";

// Tailwind's `md` breakpoint is 768px; below it the review table is unusable,
// so the review route swaps to the swipe view.
function useIsMobile(): boolean {
  const query = "(max-width: 767px)";
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

export function App() {
  const [route] = useRoute();
  const isMobile = useIsMobile();
  return (
    <div className="h-screen flex flex-col bg-bg-primary text-text-primary overflow-hidden">
      <TopNav />
      <div className="flex-1 min-h-0 overflow-y-auto">
        {route === "gather"       && <GatherView />}
        {route === "review"       && (isMobile ? <ReviewSwipeView /> : <ReviewQueueView />)}
        {route === "transactions" && <TransactionsView />}
        {route === "reporting"    && <ReportsView />}
        {route === "planning"     && <PlansView />}
        {route === "spending"     && <SpendingView />}
        {route === "scenarios"    && <ScenariosView />}
        {route === "settings"     && <PlaceholderView name="Settings" />}
      </div>
    </div>
  );
}
