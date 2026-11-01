import { Component, type ReactNode } from 'react';
import { ErrorNotice } from '../../../components/ui.js';

/** A bad file/parser must not replace the file manager or its navigation. */
export class ViewerBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <ErrorNotice error={{ messageKey: 'viewer.unavailable' }} />
    ) : (
      this.props.children
    );
  }
}
