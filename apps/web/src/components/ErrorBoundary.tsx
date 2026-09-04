import { Component, Fragment } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { ErrorState } from './ErrorState.js'

/**
 * The one class component in this codebase, because React offers no hook equivalent:
 * getDerivedStateFromError and componentDidCatch are the only way to catch a render error.
 *
 * It exists because apiGet is an unchecked cast, so every response type in this app is a claim
 * about the wire rather than a guarantee, and a server older than the frontend is the normal case
 * during an upgrade rather than an edge case. One absent field used to unmount the whole tree.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean, attempt: number }> {
  override state = { failed: false, attempt: 0 }

  static getDerivedStateFromError(): { failed: true } {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged rather than swallowed. This catches for the reader's sake, so they keep the rest of
    // the page, not to hide a bug from whoever has to fix it.
    console.error('a card failed to render', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return <ErrorState onRetry={() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))} />
    }
    // Keyed on the attempt so a retry remounts the subtree rather than reusing instances that
    // already threw. A Fragment carries the key without adding a node, which matters because this
    // sits inside a card's grid layout and a wrapper div would become a layout box.
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>
  }
}
