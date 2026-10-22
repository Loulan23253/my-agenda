class ItemView { constructor() {} }
class Plugin { constructor() {} }
class Modal {
  static choiceIndex;
  constructor() {
    this.handlers = [];
    this.modalEl = { addClass() {} };
    const node = { createDiv: () => node, createEl: () => ({ addEventListener: (_type, fn) => this.handlers.push(fn) }) };
    this.contentEl = node;
  }
  open() { if (typeof Modal.choiceIndex === 'number') this.handlers[Modal.choiceIndex]?.(); else this.onClose?.(); }
  close() { this.onClose?.(); }
}
class Notice { constructor() {} hide() {} }
class PluginSettingTab { constructor() {} display() {} hide() {} }
class Setting { setName() { return this; } setDesc() { return this; } setHeading() { return this; } addText() { return this; } addToggle() { return this; } addDropdown() { return this; } addButton() { return this; } addExtraButton() { return this; } addSlider() { return this; } setClass() { return this; } }
class TFile {} class TFolder {} class WorkspaceLeaf {} class Component {}
const setIcon = () => {}; const requestUrl = async () => ({ status: 0, text: "", headers: {} });
const normalizePath = (p) => p; const addIcon = () => {}; const moment = (x) => x;
module.exports = { ItemView, Plugin, Modal, Notice, PluginSettingTab, Setting, TFile, TFolder, WorkspaceLeaf, Component, setIcon, requestUrl, normalizePath, addIcon, moment };
