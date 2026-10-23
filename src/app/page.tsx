export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-4 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">
        Personal Finances
      </h1>
      <p className="text-lg text-zinc-600 dark:text-zinc-400">
        The project scaffold is running. Features are tracked as tickets in{" "}
        <code className="rounded bg-black/[.06] px-1.5 py-0.5 font-mono text-[0.9em] dark:bg-white/[.08]">
          docs/tickets
        </code>
        .
      </p>
    </main>
  );
}
