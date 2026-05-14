export function PlaceholderView({ name }: { name: string }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="max-w-md text-center">
        <h2 className="text-lg font-semibold text-text-primary capitalize mb-2">{name}</h2>
        <p className="text-sm text-text-muted">Not built yet — see docs/build-prompts/.</p>
      </div>
    </div>
  );
}
