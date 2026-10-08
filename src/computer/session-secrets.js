import { isOneTimeSecretField } from './names.js';

export class SessionSecrets {
  constructor(persistentVault, userId, currentOrigin) {
    this.persistentVault = persistentVault;
    this.userId = userId;
    this.currentOrigin = currentOrigin;
    this.oneTime = new Map();
  }

  names() {
    const origin = this.currentOrigin();
    const saved = this.persistentVault.listSecretNames(this.userId, origin)
      .filter(name => !isOneTimeSecretField({ name }));
    return [...new Set([...saved, ...[...this.oneTime].filter(([, v]) => v.origin === origin).map(([name]) => name)])];
  }

  get(name) {
    const origin = this.currentOrigin();
    const transient = this.oneTime.get(name);
    if (transient?.origin === origin) return transient.value;
    return isOneTimeSecretField({ name }) ? null : this.persistentVault.getSecret(this.userId, name, origin);
  }

  take(name) {
    const value = this.get(name);
    if (this.oneTime.get(name)?.origin === this.currentOrigin()) this.oneTime.delete(name);
    return value;
  }

  setOneTime(name, value, origin) {
    this.persistentVault.deleteSecret?.(this.userId, name);
    this.oneTime.set(name, { value, origin });
  }

  clear() { this.oneTime.clear(); }
}
