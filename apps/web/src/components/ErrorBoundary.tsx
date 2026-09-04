import { Component } from 'react'
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
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

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
      return <ErrorState onRetry={() => this.setState({ failed: false })} />
    }
    // A boolean is the whole of the state, and the retry needs nothing else. This carried a
    // `key={attempt}` on a Fragment as well, justified by a claim that a retry would otherwise
    // reuse the instances that already threw. That claim is false. Measured directly, with a
    // child logging from a mount effect and its cleanup: rendering the fallback runs the failed
    // child's cleanup, because the fallback replaces the children rather than sitting beside
    // them, and clearing `failed` then mounts a fresh instance. The key changed nothing, which
    // is why removing it broke no test. The observed sequence is pinned in
    // test/error-boundary.test.tsx, so a React release that stopped unmounting the failed
    // subtree would be caught rather than silently reusing a component that has already thrown.
    return this.props.children
  }
}
