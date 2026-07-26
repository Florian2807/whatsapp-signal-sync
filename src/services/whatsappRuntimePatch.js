// Compatibility adapter for WhatsApp Web model changes not yet handled by
// whatsapp-web.js. Keep private WA module access confined to this file.
async function applyWhatsAppRuntimePatch(page) {
  await page.evaluate(() => {
    if (!window.WWebJS || window.__waSignalSyncPatched) return;

    const originalGetMessageModel = window.WWebJS.getMessageModel;
    window.WWebJS.getMsgKeyId = (key) => key?._serialized ?? key?.$1 ?? undefined;

    window.WWebJS.getMessageModel = (message) => {
      const model = originalGetMessageModel(message);
      if (typeof model?.id === 'object' && model.id._serialized == null) {
        const serializedId = window.WWebJS.getMsgKeyId(model.id);
        if (serializedId) model.id = { ...model.id, _serialized: serializedId };
      }
      return model;
    };

    window.WWebJS.getChats = async () => {
      const chats = window.require('WAWebCollections').Chat.getModelsArray();
      const results = [];
      for (const chat of chats) {
        try {
          const model = await window.WWebJS.getChatModel(chat);
          if (model) results.push(model);
        } catch (_) {
          // One malformed private chat must not hide all group chats.
        }
      }
      return results;
    };

    window.WWebJS.getChatModel = async (chat, { isChannel = false } = {}) => {
      if (!chat) return null;

      const model = chat.serialize();
      model.isGroup = false;
      model.isMuted = chat.mute?.expiration !== 0;
      if (isChannel) {
        model.isChannel = window.require('WAWebChatGetters').getIsNewsletter(chat);
      } else {
        model.formattedTitle = chat.formattedTitle;
      }

      if (chat.groupMetadata) {
        model.isGroup = true;
        const chatWid = window.require('WAWebWidFactory').createWid(chat.id._serialized);
        const metadataCollection = window.require('WAWebCollections').GroupMetadata
          || window.require('WAWebCollections').WAWebGroupMetadataCollection;
        try {
          await metadataCollection?.update(chatWid);
        } catch (_) {
          // Existing metadata can still be serialized when refresh fails.
        }

        const metadata = chat.groupMetadata?.serialize?.();
        if (metadata) {
          const { toPn } = window.require('WAWebLidMigrationUtils');
          for (const participant of metadata.participants || []) {
            participant.id = toPn(participant.id) ?? participant.id;
          }
          model.groupMetadata = metadata;
          model.isReadOnly = chat.groupMetadata.announce;
        }
      }

      if (chat.newsletterMetadata) {
        const newsletterCollection = window.require('WAWebCollections').NewsletterMetadataCollection
          || window.require('WAWebCollections').WAWebNewsletterMetadataCollection;
        await newsletterCollection.update(chat.id);
        model.channelMetadata = chat.newsletterMetadata.serialize();
        model.channelMetadata.createdAtTs = chat.newsletterMetadata.creationTime;
      }

      model.lastMessage = null;
      if (model.msgs?.length) {
        const lastReceivedKeyId = window.WWebJS.getMsgKeyId(chat.lastReceivedKey);
        const messageStore = window.require('WAWebCollections').Msg;
        const lastMessage = lastReceivedKeyId
          ? messageStore.get(lastReceivedKeyId)
            || (await messageStore.getMessagesById([lastReceivedKeyId]))?.messages?.[0]
          : null;
        if (lastMessage) model.lastMessage = window.WWebJS.getMessageModel(lastMessage);
      }

      delete model.msgs;
      delete model.msgUnsyncedButtonReplyMsgs;
      delete model.unsyncedButtonReplies;
      return model;
    };

    window.__waSignalSyncPatched = true;
  });
}

module.exports = applyWhatsAppRuntimePatch;
