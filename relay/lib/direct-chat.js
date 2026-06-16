const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const SIGNALR_SEP = '\x1e';

// Default variants/options sets from bridge.js
const VARIANTS = [
  'EnableMcpServerWidgets','feature.EnableMcpServerWidgets','feature.EnableLuForChatCIQ',
  'feature.enableChatCIQPlugin','EnableRequestPlugins','feature.EnableSensitivityLabels',
  'EnableUnsupportedUrlDetector','feature.IsCustomEngineCopilotEnabled','feature.bizchatfluxv3',
  'feature.enablechatpages','feature.enableCodeCanvas','feature.turnOnWorkTabRecommendation',
  'feature.turnOnDARecommendation','feature.IsStreamingModeInChatRequestEnabled',
  'IncludeSourceAttributionsConcise','SkipPublishEmptyMessage',
  'feature.EnableDeduplicatingSourceAttributions','Enable3PActionProgressMessages',
  'feature.enableClientWebRtc','feature.EnableMeetingRecapOfSeriesMeetingWithCiq',
  'feature.EnableReferencesListCompleteSignal','feature.StorageMessageSplitDisabled',
  'feature.EnableCuaTakeControlApi','SingletonEnvOn','feature.cwcallowedos',
  'feature.EnableMergingPureDeltas','feature.disabledisallowedmsgs',
  'feature.enableCitationsForSynthesisData','feature.EnableConversationShareApis',
  'feature.enableGenerateGraphicArtOptionsSet','cdximagen',
  'feature.EnableUpdatedUXForConfirmationDialog','feature.EnableContentApiandDocTypeHtmlInRichAnswers',
  'cdxgrounding_api_v2_rich_web_answers_reference_bottom_force','cdxenablerenderforisocomp',
  'feature.EnableClientFileURLSupportForOfficeWebPaidCopilot','feature.EnableDesignerEditorImageGrounding',
  'feature.EnableDesignerEditor','feature.EnableSkipRehydrationForSpeCIdImages',
  'feature.EnableSkipEmittingMessageOnFlush','feature.EnableRemoveEmptySourceAttributions',
  'feature.EnableRemoveStreamingMode','feature.OfficeWebToHelix','feature.OfficeDesktopToHelix',
  'feature.M365TeamsHubToHelix','feature.OwaHubToHelix','feature.MonarchHubToHelix',
  'feature.Win32OutlookHubToHelix','feature.MacOutlookHubToHelix','Agt_bizchat_enableGpt5ForHelix',
];

const OPTIONS_SETS = [
  'at_mention_plugins_enable','enable_confirmation_interstitial','enable_plugin_auth_interstitial',
  'enable_request_response_interstitials','enable_response_action_processing',
  'enterprise_flux_image','enterprise_flux_web','enterprise_flux_work',
  'enterprise_toolbox_with_skdsstore','enterprise_pagination_support',
  'search_result_progress_messages_with_search_queries',
  'flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch','gptvnorm2048',
  'enterprise_flux_work_code_interpreter','cwc_code_interpreter_citation_fix',
  'code_interpreter_interactive_charts','enterprise_code_interpreter_citation_fix',
  'cwc_code_interpreter_interactive_charts_inline_image','code_interpreter_matplotlib_patching',
  'enable_batch_token_processing','disable_cea_message_listener','enable_selective_url_redaction',
  'update_memory_plugin','add_custom_instructions','agent_recommendations','enable_gg_gpt',
  'enable_inferred_memory_read','flux_v3_image_gen_enable_dimensions',
  'flux_v3_image_gen_enable_icon_dimensions','flux_v3_image_gen_enable_system_text_with_params',
  'flux_v3_image_gen_enable_designer_dimensions_meta_prompting_in_system_prompts',
];

const ALLOWED_MESSAGE_TYPES = [
  'Chat','Suggestion','InternalSearchQuery','Disengaged','InternalLoaderMessage',
  'Progress','GeneratedCode','RenderCardRequest','AdsQuery','SemanticSerp',
  'GenerateContentQuery','GenerateGraphicArt','SearchQuery','ConfirmationCard',
  'AuthError','DeveloperLogs','TriggerPlugin','HintInvocation','MemoryUpdate',
  'EndOfRequest','TriggerConfirmation','ResumeInvokeAction','ResumeUserInputRequest',
  'TriggerUserInputRequest','EscapeHatch','TriggerPluginAuth','ResumePluginAuth',
  'SideBySide','ReferencesListComplete','SwitchRespondingEndpoint',
];

function buildWsUrl(templateUrl, convId, sessionId, reqId) {
  const u = new URL(templateUrl);
  u.searchParams.set('ClientRequestId', reqId);
  u.searchParams.set('X-SessionId', sessionId);
  u.searchParams.set('ConversationId', convId);
  return u.toString();
}

function buildChatInvoke(text, convId, sessionId, reqId, isStartOfSession, tone) {
  return JSON.stringify({
    arguments: [{
      source: 'officeweb', clientCorrelationId: reqId,
      sessionId, optionsSets: OPTIONS_SETS,
      streamingMode: 'ConciseWithPadding', spokenTextMode: 'None',
      options: {}, extraExtensionParameters: {},
      allowedMessageTypes: ALLOWED_MESSAGE_TYPES,
      sliceIds: [], threadLevelGptId: {},
      traceId: reqId, isStartOfSession: !!isStartOfSession,
      clientInfo: {
        clientPlatform: 'mcmcopilot-web', clientAppName: 'Office',
        clientEntrypoint: 'mcmcopilot-officeweb', clientSessionId: sessionId,
        clientAppType: 'Web', deviceOS: 'Windows', deviceType: 'Desktop',
        ProductCategory: 'Chat', productEntryPoint: 'ChatPanel',
      },
      message: {
        author: 'user', inputMethod: 'Keyboard', text,
        entityAnnotationTypes: ['People','File','Event','Email','TeamsMessage'],
        requestId: reqId,
        locationInfo: { timeZoneOffset: 0, timeZone: 'UTC' },
        locale: 'en-us', messageType: 'Chat', experienceType: 'Default',
        adaptiveCards: [], clientPreferences: {},
      },
      plugins: [{ Id: 'BingWebSearch', Source: 'BuiltIn' }],
      isSbsSupported: true,
      tone,
      renderReferencesBehindEOS: true,
    }],
    invocationId: '0', target: 'chat', type: 4,
  }) + SIGNALR_SEP;
}

function computeDelta(oldText, newText) {
  if (!oldText) return newText;
  if (newText.indexOf(oldText) === 0) return newText.substring(oldText.length);
  if (oldText.indexOf(newText) === 0) return '';
  const minLen = Math.min(newText.length, oldText.length);
  let commonLen = 0;
  for (let i = 0; i < minLen; i++) {
    if (newText[i] === oldText[i]) commonLen++;
    else break;
  }
  if (commonLen > 0) return newText.substring(commonLen);
  return newText;
}

function isReasoningMessage(msg) {
  if (!msg) return false;
  if (msg.addToChainOfThought === true) return true;
  if (msg.contentType === 'Code' || msg.contentType === 'Tool') return true;
  const mt = msg.messageType || '';
  if (['InternalLoaderMessage','Progress','Thinking'].includes(mt)) return true;
  if (msg.hiddenText) return true;
  return false;
}

function isUiArtifact(text) {
  if (!text) return true;
  const t = text.trim();
  if (!t || t.length <= 1) return true;
  const UI_ARTIFACTS = ['Hide','Show','Thinking...','Reasoning...','Stop','Regenerate',
    'New topic','New chat','Try again','Continue','\u00a0','\u200b','\ufeff'];
  for (const a of UI_ARTIFACTS) if (t === a) return true;
  return /^(Thinking|Reasoning|Stop|Show|Hide|New\s+(chat|topic|conversation))\.\.\.?$/i.test(t);
}

function getMessageText(msg) {
  return (msg && msg.text) ? String(msg.text) : '';
}

class DirectChat {
  constructor({ templateUrl, tone = 'Gpt_5_5_Reasoning' }) {
    this.templateUrl = templateUrl;
    this.tone = tone;
    this.convId = null;
    this.sessionId = null;
    this.ws = null;
    this.pending = [];
    this.finalBuffer = '';
    this.reasoningEmitted = {};
    this.isStreaming = false;
    this.onDelta = null;
    this.onReasoningDelta = null;
    this.onDone = null;
    this.onError = null;
  }

  clear() {
    this.convId = null;
    this.sessionId = null;
    this.finalBuffer = '';
    this.reasoningEmitted = {};
    this.isStreaming = false;
  }

  send(text) {
    const reqId = uuidv4();
    const isStartOfSession = !this.convId;
    this.convId = this.convId || uuidv4();
    this.sessionId = this.sessionId || uuidv4();
    this.isStreaming = true;
    this.finalBuffer = '';
    this.reasoningEmitted = {};

    const url = buildWsUrl(this.templateUrl, this.convId, this.sessionId, reqId);
    const ws = new WebSocket(url, { origin: 'https://m365.cloud.microsoft' });
    this.ws = ws;
    let handshakeDone = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + SIGNALR_SEP);
    });

    ws.on('message', (data) => {
      const raw = data.toString();
      const parts = raw.split(SIGNALR_SEP);
      for (const part of parts) {
        if (!part.trim()) continue;
        if (!handshakeDone) {
          handshakeDone = true;
          ws.send(buildChatInvoke(text, this.convId, this.sessionId, reqId, isStartOfSession, this.tone));
          continue;
        }

        let msg;
        try { msg = JSON.parse(part); } catch (e) { continue; }
        const t = msg.type;
        if (t === 6) continue;

        if (t === 1 && msg.target === 'update') {
          const arg0 = msg.arguments && msg.arguments[0];
          if (!arg0) continue;

          if (typeof arg0.writeAtCursor === 'string') {
            const newFinal = this.finalBuffer + arg0.writeAtCursor;
            const delta = computeDelta(this.finalBuffer, newFinal);
            if (delta && !isUiArtifact(delta)) {
              this.finalBuffer = newFinal;
              if (this.onDelta) this.onDelta(delta);
            }
          }

          if (Array.isArray(arg0.messages) && arg0.messages.length > 0) {
            for (const mMsg of arg0.messages) {
              const mText = getMessageText(mMsg);
              if (!mText) continue;
              if (isReasoningMessage(mMsg)) {
                const mId = mMsg.messageId || '';
                const prev = this.reasoningEmitted[mId] || '';
                const rd = computeDelta(prev, mText);
                if (rd) {
                  this.reasoningEmitted[mId] = mText;
                  if (this.onReasoningDelta) this.onReasoningDelta(rd);
                }
              } else if (mMsg.author !== 'user') {
                const finalDelta = computeDelta(this.finalBuffer, mText);
                if (finalDelta) {
                  this.finalBuffer = mText;
                  if (!isUiArtifact(finalDelta) && this.onDelta) this.onDelta(finalDelta);
                }
              }
            }
          }
        }

        if (t === 2) {
          const ims = ((msg.item || {}).messages) || [];
          for (let k = ims.length - 1; k >= 0; k--) {
            if (ims[k].author !== 'user') {
              const fullText = getMessageText(ims[k]);
              if (!fullText) continue;
              if (this.finalBuffer.length >= fullText.length || this.finalBuffer.indexOf(fullText) !== -1) {
                if (fullText.length > this.finalBuffer.length) this.finalBuffer = fullText;
                break;
              }
              if (this.finalBuffer.length > 0 && fullText.indexOf(this.finalBuffer) === 0) {
                const remaining = fullText.substring(this.finalBuffer.length);
                if (remaining && this.onDelta) this.onDelta(remaining);
              } else {
                if (this.onDelta) this.onDelta({ type: 'message', text: fullText, turnState: msg.item.turnState });
              }
              this.finalBuffer = fullText;
              break;
            }
          }
        }

        if (t === 3) {
          this.isStreaming = false;
          if (this.onDone) this.onDone();
          try { ws.close(); } catch(e){}
        }
      }
    });

    ws.on('error', (err) => {
      this.isStreaming = false;
      if (this.onError) this.onError('Substrate connection error: ' + err.message);
    });

    ws.on('close', () => {
      this.isStreaming = false;
    });
  }

  stop() {
    this.isStreaming = false;
    if (this.ws) try { this.ws.close(); } catch(e){}
  }
}

module.exports = { DirectChat, buildWsUrl, buildChatInvoke };
