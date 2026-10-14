import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { t } from '../i18n.js';

// The request is posted in the channel. Only the requesting user can open the modal.
export function secretRequestPayload(reqId, message, fields, origin = '', lang = 'en') {
  const embed = new EmbedBuilder()
    .setTitle(t(lang, 'cu.secretTitle'))
    .setDescription(message)
    .addFields({ name: t(lang, 'cu.secretFields'), value: fields.map(f => '・' + f.label).join(' / ') },
      { name: t(lang, 'cu.secretOrigin'), value: origin || t(lang, 'cu.secretOriginNone') })
    .setColor(0xfaa61a)
    .setFooter({ text: fields.some(f => f.one_time)
      ? t(lang, 'cu.secretFooterOtp')
      : t(lang, 'cu.secretFooter') });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cu_secret:' + reqId).setLabel(t(lang, 'cu.secretBtn')).setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

export function secretModal(reqId, fields, lang = 'en') {
  const modal = new ModalBuilder().setCustomId('cu_secret_modal:' + reqId).setTitle(t(lang, 'cu.secretModalTitle'));
  modal.addComponents(...fields.map(f => new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(f.name)
      .setLabel(f.label.slice(0, 45))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(500),
  )));
  return modal;
}

export function viewerPayload(png, lang = 'en') {
  const embed = new EmbedBuilder()
    .setTitle('🖥️ 作業中の画面')
    .setDescription('現在の専用ブラウザ画面です。作業はチャットから依頼できます。')
    .setImage('attachment://harklet-browser.jpg')
    .setColor(0x5865f2);
  return { embeds: [embed], files: [new AttachmentBuilder(png, { name: 'harklet-browser.jpg' })] };
}

export function authMethodPayload(reqId, message, options, lang = 'en') {
  const embed = new EmbedBuilder().setTitle(t(lang, 'cu.authTitle'))
    .setDescription(message).setColor(0xfaa61a);
  const menu = new StringSelectMenuBuilder().setCustomId('cu_auth:' + reqId)
    .setPlaceholder(t(lang, 'cu.authPlaceholder')).addOptions(options.map(o => ({ label: o.label, value: o.id })));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

export function authQrPayload(reqId, png, message, lang = 'en') {
  const embed = new EmbedBuilder().setTitle(t(lang, 'cu.qrTitle'))
    .setDescription(message).setImage('attachment://harklet-auth.jpg').setColor(0xfaa61a);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cu_qr:' + reqId).setLabel(t(lang, 'cu.qrBtn')).setStyle(ButtonStyle.Primary));
  return { embeds: [embed], components: [row], files: [new AttachmentBuilder(png, { name: 'harklet-auth.jpg' })] };
}

// A human-only check (hCaptcha etc.) appeared on the page. The viewer link is
// private, so it is sent by DM; only the requester can press the button.
export function humanCheckPayload(reqId, message, hasViewer, lang = 'en') {
  const embed = new EmbedBuilder()
    .setTitle(t(lang, 'cu.humanTitle'))
    .setDescription(message + (hasViewer ? t(lang, 'cu.humanLinkNote') : ''))
    .setColor(0xfaa61a)
    .setFooter({ text: t(lang, 'cu.humanFooter') });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cu_human:' + reqId).setLabel(t(lang, 'cu.humanBtn')).setStyle(ButtonStyle.Primary));
  return { embeds: [embed], components: [row] };
}
