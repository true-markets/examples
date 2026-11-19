import { Component, type ReactNode } from "react";

// Keeps one panel's crash from taking down the whole console: the panel shows the error and a
// button to try again, and everything else keeps streaming.
export class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error(`${this.props.name} panel crashed:`, error);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-md border border-sell/40 bg-panel p-4 text-center text-xs">
        <div className="font-semibold text-sell">The {this.props.name} panel hit an error</div>
        <div className="max-w-md text-muted">{this.state.error.message}</div>
        <button type="button" className="rounded border border-line bg-raised px-2.5 py-1 text-ink hover:border-faint" onClick={() => this.setState({ error: undefined })}>
          Try again
        </button>
      </div>
    );
  }
}
