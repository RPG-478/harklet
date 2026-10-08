import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';

// The request is posted in the channel. Only the requesting user can open the modal.
export function secretRequestPayload(reqId, message, fields, origin = '') {
  const embed = new EmbedBuilder()
    .setTitle('🔐 ログイン情報の入力')
    .setDescription(message)
    .addFields({ name: '入力する項目', value: fields.map(f => '・' + f.label).join(' / ') },
      { name: '使用するサイト', value: origin || '未指定' })
    .setColor(0xfaa61a)
    .setFooter({ text: '入力値は暗号化して保存し、AIには渡しません。依頼した本人だけが押せます' });
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
    .setDescription('現在の専用ブラウザ画面です。操作は /computer run から依頼できます。')
    .setImage('attachment://harklet-browser.png')
    .setColor(0x5865f2);
  return { embeds: [embed], files: [new AttachmentBuilder(png, { name: 'harklet-browser.png' })] };
}
