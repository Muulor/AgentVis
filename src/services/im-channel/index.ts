/**
 * IM Channel 模块导出索引
 */

// 类型导出
export type {
  ImPlatform,
  ImIncomingMessage,
  ImProgressEvent,
  ImProgressEventType,
  ImCardContent,
  ImCardSection,
  ImCardAction,
  ImChannelConfig,
  FeishuChannelConfig,
  SlackChannelConfig,
  ImCardUpdateContext,
  ImChannel,
  ImChannelCreator,
  ImTaskStatus,
  ImTask,
  ConnectionStateHandler,
  MessageHandler,
  CardActionHandler,
} from './types';

// 工厂函数导出
export {
  registerPlatform,
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  createChannel,
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  getChannel,
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  getActiveChannel,
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  destroyChannel,
  destroyAllChannels,
  getSupportedPlatforms,
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  getConnectedPlatforms,
  UnsupportedPlatformError,
  ChannelAlreadyExistsError,
} from './ImChannelFactory';
