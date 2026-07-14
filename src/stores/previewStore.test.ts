import { beforeEach, describe, expect, it, vi } from 'vitest';

const stopProject = vi.hoisted(() => vi.fn<(projectRequestId?: number) => Promise<void>>());

vi.mock('@services/preview/VitePreviewService', () => ({
  vitePreviewService: { stopProject },
}));

import { usePreviewStore } from './previewStore';

async function expectProjectStop(): Promise<void> {
  await vi.waitFor(() => expect(stopProject).toHaveBeenCalledTimes(1));
}

describe('previewStore project lifecycle', () => {
  beforeEach(() => {
    stopProject.mockReset();
    stopProject.mockResolvedValue();
    usePreviewStore.setState({
      isPreviewActive: false,
      previewMode: 'html',
      previewCode: null,
      previewTitle: null,
      previewBaseDir: null,
      projectUrl: null,
      projectStatus: 'idle',
      projectRequestId: 0,
      projectCanRetry: false,
      projectTemplate: null,
      projectError: null,
    });
  });

  it('stops the managed project in the background when closing preview', async () => {
    const requestId = usePreviewStore.getState().startProjectPreview('vanilla');

    usePreviewStore.getState().closePreview();

    expect(usePreviewStore.getState()).toMatchObject({
      isPreviewActive: false,
      previewMode: 'html',
      projectStatus: 'idle',
      projectUrl: null,
    });
    await expectProjectStop();
    expect(stopProject).toHaveBeenCalledWith(requestId);
  });

  it('stops the managed project when switching directly to HTML preview', async () => {
    const requestId = usePreviewStore.getState().startProjectPreview('react-tailwind');

    usePreviewStore.getState().openPreview('<h1>Report</h1>', 'report.html');

    expect(usePreviewStore.getState()).toMatchObject({
      isPreviewActive: true,
      previewMode: 'html',
      previewCode: '<h1>Report</h1>',
      previewTitle: 'report.html',
    });
    await expectProjectStop();
    expect(stopProject).toHaveBeenCalledWith(requestId);
  });

  it('does not load the project service when closing an HTML preview', async () => {
    usePreviewStore.getState().openPreview('<p>HTML only</p>');
    expect(usePreviewStore.getState().previewTitle).toBe('实时预览');

    usePreviewStore.getState().closePreview();
    await Promise.resolve();

    expect(stopProject).not.toHaveBeenCalled();
  });

  it('invalidates stale async project starts on replacement and close', async () => {
    const firstRequest = usePreviewStore.getState().startProjectPreview('vanilla');
    expect(usePreviewStore.getState().isProjectRequestCurrent(firstRequest)).toBe(true);

    const secondRequest = usePreviewStore.getState().startProjectPreview('react-tailwind');
    expect(secondRequest).toBeGreaterThan(firstRequest);
    expect(usePreviewStore.getState().isProjectRequestCurrent(firstRequest)).toBe(false);
    expect(usePreviewStore.getState().isProjectRequestCurrent(secondRequest)).toBe(true);
    await expectProjectStop();
    expect(stopProject).toHaveBeenNthCalledWith(1, firstRequest);

    usePreviewStore.getState().closePreview();
    expect(usePreviewStore.getState().isProjectRequestCurrent(secondRequest)).toBe(false);
    await vi.waitFor(() => expect(stopProject).toHaveBeenCalledTimes(2));
    expect(stopProject).toHaveBeenNthCalledWith(2, secondRequest);
  });

  it('invalidates a pre-service request synchronously without starting background cleanup', () => {
    const requestId = usePreviewStore.getState().startProjectPreview('vanilla');

    usePreviewStore.getState().invalidateProjectRequest();

    expect(usePreviewStore.getState().isProjectRequestCurrent(requestId)).toBe(false);
    expect(usePreviewStore.getState()).toMatchObject({
      projectUrl: null,
      projectStatus: 'idle',
      projectCanRetry: false,
      projectError: null,
    });
    expect(stopProject).not.toHaveBeenCalled();
  });

  it('only enables retry after the current request reaches the preview service', async () => {
    const firstRequest = usePreviewStore.getState().startProjectPreview('vanilla');
    expect(usePreviewStore.getState().projectCanRetry).toBe(false);

    expect(usePreviewStore.getState().markProjectRequestSubmitted(firstRequest)).toBe(true);
    expect(usePreviewStore.getState().projectCanRetry).toBe(true);

    const secondRequest = usePreviewStore.getState().startProjectPreview('react-tailwind');
    expect(usePreviewStore.getState().projectCanRetry).toBe(false);
    expect(usePreviewStore.getState().markProjectRequestSubmitted(firstRequest)).toBe(false);
    expect(usePreviewStore.getState().projectCanRetry).toBe(false);
    await expectProjectStop();
    expect(stopProject).toHaveBeenCalledWith(firstRequest);
    stopProject.mockClear();

    expect(usePreviewStore.getState().markProjectRequestSubmitted(secondRequest)).toBe(true);
    usePreviewStore.getState().closePreview();
    expect(usePreviewStore.getState().projectCanRetry).toBe(false);
    await expectProjectStop();
    expect(stopProject).toHaveBeenCalledWith(secondRequest);
  });

  it('updates an inferred template without replacing the active request generation', () => {
    const requestId = usePreviewStore.getState().startProjectPreview('vanilla');

    usePreviewStore.getState().setProjectTemplate('react-tailwind');

    expect(usePreviewStore.getState()).toMatchObject({
      projectRequestId: requestId,
      projectTemplate: 'react-tailwind',
    });
    expect(usePreviewStore.getState().isProjectRequestCurrent(requestId)).toBe(true);
  });
});
