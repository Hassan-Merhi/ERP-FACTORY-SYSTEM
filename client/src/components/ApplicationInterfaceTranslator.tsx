import { useEffect } from "react";
import type { ApplicationLanguage } from "@shared/applicationLanguageContract";
import { translateApplicationLiteral } from "@/i18n/applicationTranslations";
import { isFinalCloseoutText, translateFinalCloseoutText } from "@/i18n/finalCloseoutTranslations";
import { translateSharedInterfaceText } from "@/i18n/sharedInterfaceTranslations";
import { translateTabsFiltersText } from "@/i18n/tabsFiltersTranslations";
import { translateVoucherKpiText } from "@/i18n/voucherKpiTranslations";
import { translateAccountingDocumentText } from "@/i18n/accountingDocumentTranslations";
import { isPhase3SharedUiText, translatePhase3SharedUiText } from "@/i18n/sharedUiPhase3Translations";
import {
  isPhase4SupplierPartnerText,
  translatePhase4SupplierPartnerText,
} from "@/i18n/supplierPartnerPhase4Translations";
import {
  isPhase5PropertiesRentalsText,
  translatePhase5PropertiesRentalsText,
} from "@/i18n/propertiesRentalsPhase5Translations";
import { isPhase6ReportsExportsText, translatePhase6ReportsExportsText } from "@/i18n/reportsExportsPhase6Translations";
import {
  isPhase7BackendMessageText,
  translatePhase7BackendMessageText,
} from "@/i18n/backendMessagesPhase7Translations";
import { translateFactoryProductionPlannerText } from "@/i18n/factoryProductionPlannerTranslations";
import { translateFactoryInsuranceText } from "@/i18n/factoryInsuranceTranslations";
import {
  isPosItemReplacementText,
  translatePosItemReplacementLiteral,
} from "@/i18n/posItemReplacement.applicationTranslations";

const HARD_EXCLUDED_SELECTOR = [
  "code",
  "pre",
  "[contenteditable=true]",
  "[data-no-translate]",
  "[data-business-value]",
  "[data-business-row]",
  "[data-stock-name]",
  "[data-stock-group]",
  "[data-account-name]",
  "[data-article-code]",
  "[data-account-code]",
  "[data-container-number]",
  "[data-voucher-number]",
  "[data-property-name]",
  "[data-unit-name]",
  "[data-tenant-name]",
  "[data-contract-reference]",
].join(",");

const SOFT_EXCLUDED_SELECTOR = [
  "option",
  "td:not([data-i18n-ui])",
  "[role=cell]:not([data-i18n-ui])",
  "[role=gridcell]:not([data-i18n-ui])",
].join(",");

const ELIGIBLE_TEXT_SELECTOR = [
  "button",
  "label",
  "legend",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "nav a",
  "[role=button]",
  "[role=menuitem]",
  "[role=option]",
  "[role=tab]",
  "[role=columnheader]",
  "[role=heading]",
  "[data-i18n-ui]",
].join(",");

const TRANSLATABLE_ATTRIBUTES = ["aria-label", "title", "placeholder"] as const;
const PORTAL_SELECTOR = "[data-radix-portal], [data-i18n-portal]";

type TranslatableAttribute = (typeof TRANSLATABLE_ATTRIBUTES)[number];

interface TranslationMemory {
  source: string;
  applied: string;
}

const textTranslationMemory = new WeakMap<Text, TranslationMemory>();
const attributeTranslationMemory = new WeakMap<Element, Map<TranslatableAttribute, TranslationMemory>>();

function isHardProtected(element: Element): boolean {
  return Boolean(element.closest(HARD_EXCLUDED_SELECTOR));
}

function isSoftProtected(element: Element): boolean {
  return Boolean(element.closest(SOFT_EXCLUDED_SELECTOR));
}

function isEligibleTextElement(element: Element): boolean {
  return element.matches(ELIGIBLE_TEXT_SELECTOR) || Boolean(element.closest(ELIGIBLE_TEXT_SELECTOR));
}

function isApprovedNonVisualText(value: string): boolean {
  return (
    isFinalCloseoutText(value) ||
    isPhase3SharedUiText(value) ||
    isPhase4SupplierPartnerText(value) ||
    isPhase5PropertiesRentalsText(value) ||
    isPhase6ReportsExportsText(value) ||
    isPhase7BackendMessageText(value) ||
    isPosItemReplacementText(value)
  );
}

export function translateApprovedInterfaceText(value: string, language: ApplicationLanguage): string | null {
  return (
    translateFinalCloseoutText(value, language) ??
    translateApplicationLiteral(value, language) ??
    translateTabsFiltersText(value, language) ??
    translateVoucherKpiText(value, language) ??
    translatePhase7BackendMessageText(value, language) ??
    translatePosItemReplacementLiteral(value, language) ??
    translateFactoryProductionPlannerText(value, language) ??
    translateFactoryInsuranceText(value, language) ??
    translatePhase6ReportsExportsText(value, language) ??
    translatePhase5PropertiesRentalsText(value, language) ??
    translatePhase4SupplierPartnerText(value, language) ??
    translatePhase3SharedUiText(value, language) ??
    translateSharedInterfaceText(value, language) ??
    translateAccountingDocumentText(value, language)
  );
}

function getTextMemory(node: Text, currentValue: string): TranslationMemory {
  const existing = textTranslationMemory.get(node);
  if (existing && currentValue === existing.applied) return existing;

  const next = { source: currentValue, applied: currentValue };
  textTranslationMemory.set(node, next);
  return next;
}

function getAttributeMemory(
  element: Element,
  attribute: TranslatableAttribute,
  currentValue: string
): TranslationMemory {
  let attributes = attributeTranslationMemory.get(element);
  if (!attributes) {
    attributes = new Map();
    attributeTranslationMemory.set(element, attributes);
  }

  const existing = attributes.get(attribute);
  if (existing && currentValue === existing.applied) return existing;

  const next = { source: currentValue, applied: currentValue };
  attributes.set(attribute, next);
  return next;
}

function translateTextNode(node: Text, language: ApplicationLanguage) {
  const parent = node.parentElement;
  if (!parent || isHardProtected(parent)) return;

  const currentValue = node.nodeValue ?? "";
  const memory = getTextMemory(node, currentValue);
  const approved = isApprovedNonVisualText(memory.source);
  if (isSoftProtected(parent) && !approved) return;

  if (!isEligibleTextElement(parent) && !approved) {
    if (currentValue !== memory.source) {
      memory.applied = memory.source;
      node.nodeValue = memory.source;
    }
    return;
  }

  const translated = translateApprovedInterfaceText(memory.source, language);
  if (translated !== null) {
    memory.applied = translated;
    if (translated !== currentValue) node.nodeValue = translated;
    return;
  }

  if (currentValue !== memory.source) {
    memory.applied = memory.source;
    node.nodeValue = memory.source;
  }
}

function translateAttributes(element: Element, language: ApplicationLanguage) {
  if (isHardProtected(element) || isSoftProtected(element)) return;

  for (const attribute of TRANSLATABLE_ATTRIBUTES) {
    const currentValue = element.getAttribute(attribute);
    if (!currentValue) continue;

    const memory = getAttributeMemory(element, attribute, currentValue);
    const translated = translateApprovedInterfaceText(memory.source, language);
    const nextValue = (translated ?? memory.source).trim();

    memory.applied = nextValue;
    if (nextValue !== currentValue) element.setAttribute(attribute, nextValue);
  }
}

export function translateInterfaceTree(root: Node, language: ApplicationLanguage) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as Text, language);
    return;
  }
  if (root.nodeType === Node.ELEMENT_NODE) translateAttributes(root as Element, language);

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let current: Node | null = walker.nextNode();
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) translateTextNode(current as Text, language);
    else translateAttributes(current as Element, language);
    current = walker.nextNode();
  }
}

export function ApplicationInterfaceTranslator({ language }: { language: ApplicationLanguage }) {
  useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return;

    const pending = new Set<Node>();
    let frame: number | null = null;

    const flush = () => {
      frame = null;
      for (const node of pending) translateInterfaceTree(node, language);
      pending.clear();
    };

    const schedule = (node: Node) => {
      pending.add(node);
      if (frame === null) frame = window.requestAnimationFrame(flush);
    };

    translateInterfaceTree(root, language);
    document.querySelectorAll(PORTAL_SELECTOR).forEach((portal) => translateInterfaceTree(portal, language));

    const rootObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) schedule(node);
        if (record.type === "characterData" || record.type === "attributes") schedule(record.target);
      }
    });
    rootObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATABLE_ATTRIBUTES],
    });

    const portalObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const element = node as Element;
          if (element.matches(PORTAL_SELECTOR)) schedule(element);
          element.querySelectorAll(PORTAL_SELECTOR).forEach(schedule);
        }
      }
    });
    portalObserver.observe(document.body, { childList: true, subtree: true });

    return () => {
      rootObserver.disconnect();
      portalObserver.disconnect();
      pending.clear();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [language]);

  return null;
}
