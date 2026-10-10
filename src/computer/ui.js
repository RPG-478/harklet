import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';

// The request is posted in the channel. Only the requesting user can open the modal.
export function secretRequestPayload(reqId, message, fields, origin = '') {
  const embed = new EmbedBuilder()
    .setTitle('🔐 ログイン情報の入力')
    .setDescription(message)
    .addFields({ name: '入力する項目', value: fields.map(f => '・' + f.label).join(' / ') },
      { name: '使用するサイト', value: origin || '未指定' })
    .setColor(0xfaa61a)
    .setFooter({ text: fields.some(f => f.one_time)
      ? '認証コードは保存せず一時利用。その他の値は暗号化保存し、AIには渡しません'
      : '入力値は暗号化して保存し、AIには渡しません。依頼した本人だけが押せます' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cu_secret:' + reqId).setLabel('入力する').setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

export function secretModal(reqId, fields) {
  const modal = new ModalBuilder().setCustomId('cu_secret_modal:' + reqId).setTitle('ログイン情報');
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

export function viewerPayload(png) {
  const embed = new EmbedBuilder()
    .setTitle('🖥️ 作業中の画面')
    .setDescription('現在の専用ブラウザ画面です。作業はチャットから依頼できます。')
    .setImage('attachment://harklet-browser.jpg')
    .setColor(0x5865f2);
  return { embeds: [embed], files: [new AttachmentBuilder(png, { name: 'harklet-browser.jpg' })] };
}

export function authMethodPayload(reqId, message, options) {
  const embed = new EmbedBuilder().setTitle('🔐 認証方法を選択')
    .setDescription(message).setColor(0xfaa61a);
  const menu = new StringSelectMenuBuilder().setCustomId('cu_auth:' + reqId)
    .setPlaceholder('使用する認証方法').addOptions(options.map(o => ({ label: o.label, value: o.id })));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

export function authQrPayload(reqId, png, message) {
  const embed = new EmbedBuilder().setTitle('🔐 認証用の画面')
    .setDescription(message).setImage('attachment://harklet-auth.jpg').setColor(0xfaa61a);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cu_qr:' + reqId).setLabel('確認して続ける').setStyle(ButtonStyle.Primary));
  return { embeds: [embed], components: [row], files: [new AttachmentBuilder(png, { name: 'harklet-auth.jpg' })] };
}

// A human-only check (hCaptcha etc.) appeared on the page. The viewer link is
// private, so it is sent by DM; only the requester can press the button.
export function humanCheckPayload(reqId, message, hasViewer) {
  const embed = new EmbedBuilder()
    .setTitle('🧩 人間確認が出ています')
    .setDescription(message + (hasViewer ? '\n画面リンクはDMに送りました。' : ''))
    .setColor(0xfaa61a)
    .setFooter({ text: '依頼した本人だけが押せます' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cu_human:' + reqId).setLabel('解決した').setStyle(ButtonStyle.Primary));
  return { embeds: [embed], components: [row] };
}
