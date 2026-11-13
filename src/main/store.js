// Persistência simples em JSON (configurações e histórico) dentro da pasta userData.
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.data = this._load();
    this._timer = null;
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(this.defaults)) return Array.isArray(parsed) ? parsed : [];
      return { ...this.defaults, ...parsed };
    } catch {
      return Array.isArray(this.defaults) ? [] : { ...this.defaults };
    }
  }

  // Grava com pequeno atraso para agrupar várias alterações seguidas.
  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('Falha ao salvar', this.filePath, err);
    }
  }
}

module.exports = { JsonStore };
