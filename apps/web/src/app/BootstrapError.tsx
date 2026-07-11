export interface BootstrapErrorProps {
  readonly error: unknown;
  readonly onRetry: () => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "无法打开本地学习账本";
}

export function BootstrapError({ error, onRetry }: BootstrapErrorProps) {
  return (
    <div className="app-shell">
      <main className="app-main">
        <section
          className="utility-view state-view"
          aria-labelledby="bootstrap-error-title"
        >
          <h1 className="wordmark" id="bootstrap-error-title">
            Tenjin
          </h1>
          <p role="alert">无法打开本地学习账本：{message(error)}</p>
          <button className="secondary-action" type="button" onClick={onRetry}>
            重新打开
          </button>
        </section>
      </main>
    </div>
  );
}
