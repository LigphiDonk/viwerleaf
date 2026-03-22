import { Component, type ErrorInfo, type ReactNode } from "react";

interface PaneErrorBoundaryProps {
  title: string;
  resetKey?: string;
  children: ReactNode;
}

interface PaneErrorBoundaryState {
  error: Error | null;
}

export class PaneErrorBoundary extends Component<PaneErrorBoundaryProps, PaneErrorBoundaryState> {
  state: PaneErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): PaneErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[ViewerLeaf] pane crashed: ${this.props.title}`, error, errorInfo);
  }

  componentDidUpdate(prevProps: PaneErrorBoundaryProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="pane-error-boundary" role="alert">
        <div className="pane-error-boundary__eyebrow">Pane Error</div>
        <div className="pane-error-boundary__title">{this.props.title}</div>
        <div className="pane-error-boundary__message">
          {this.state.error.message || "An unexpected rendering error occurred."}
        </div>
        <button
          type="button"
          className="pane-error-boundary__action"
          onClick={this.handleReset}
        >
          Reload Pane
        </button>
      </div>
    );
  }
}
