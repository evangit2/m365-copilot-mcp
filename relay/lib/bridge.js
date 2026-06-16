(function () {
  'use strict';

  var SIGNALR_SEP = '\x1e';
  var _pending = [];
  var _wsUrlTemplate = null;
  var _modelTone = 'Gpt_5_5_Reasoning';
  var _currentConvId = null;
  var _currentSessionId = null;
  var _currentWs = null;
  var _isStreaming = false;

  // ── Accumulators ─────────────────────────────────────────
  var _finalBuffer = '';      // accumulated writeAtCursor text
  var _reasoningBuffer = '';  // accumulated reasoning text
  var _reasoningEmitted = {}; // track which messageIds we've emitted

  var VARIANTS = [
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

  var OPTIONS_SETS = [
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

  var ALLOWED_MESSAGE_TYPES = [
    'Chat','Suggestion','InternalSearchQuery','Disengaged','InternalLoaderMessage',
    'Progress','GeneratedCode','RenderCardRequest','AdsQuery','SemanticSerp',
    'GenerateContentQuery','GenerateGraphicArt','SearchQuery','ConfirmationCard',
    'AuthError','DeveloperLogs','TriggerPlugin','HintInvocation','MemoryUpdate',
    'EndOfRequest','TriggerConfirmation','ResumeInvokeAction','ResumeUserInputRequest',
    'TriggerUserInputRequest','EscapeHatch','TriggerPluginAuth','ResumePluginAuth',
    'SideBySide','ReferencesListComplete','SwitchRespondingEndpoint',
  ];

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
      var r=Math.random()*16|0; return (c==='x'?r:(r&0x3|0x8)).toString(16);
    });
  }

  // Intercept WebSocket constructor to capture substrate URL template
  var _OrigWS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    var u = String(url || '');
    if (u.indexOf('substrate.office.com') !== -1 && u.indexOf('access_token=') !== -1) {
      _wsUrlTemplate = u;
      window.__m365CapturedUrl = u;
    }
    return new _OrigWS(url, protocols);
  };
  window.WebSocket.prototype = _OrigWS.prototype;
  window.WebSocket.CONNECTING = _OrigWS.CONNECTING;
  window.WebSocket.OPEN = _OrigWS.OPEN;
  window.WebSocket.CLOSING = _OrigWS.CLOSING;
  window.WebSocket.CLOSED = _OrigWS.CLOSED;

  function buildWsUrl(convId, sessionId, reqId) {
    if (!_wsUrlTemplate) return null;
    try {
      var u = new URL(_wsUrlTemplate);
      u.searchParams.set('ClientRequestId', reqId);
      u.searchParams.set('X-SessionId', sessionId);
      u.searchParams.set('ConversationId', convId);
      return u.toString();
    } catch (e) {
      return _wsUrlTemplate
        .replace(/ClientRequestId=[^&]+/, 'ClientRequestId=' + reqId)
        .replace(/X-SessionId=[^&]+/, 'X-SessionId=' + sessionId)
        .replace(/ConversationId=[^&]+/, 'ConversationId=' + convId);
    }
  }

  function buildChatInvoke(text, convId, sessionId, reqId, isStartOfSession) {
    return JSON.stringify({
      arguments: [{
        source: 'officeweb', clientCorrelationId: reqId,
        sessionId: sessionId, optionsSets: OPTIONS_SETS,
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
          author: 'user', inputMethod: 'Keyboard', text: text,
          entityAnnotationTypes: ['People','File','Event','Email','TeamsMessage'],
          requestId: reqId,
          locationInfo: { timeZoneOffset: 0, timeZone: 'UTC' },
          locale: 'en-us', messageType: 'Chat', experienceType: 'Default',
          adaptiveCards: [], clientPreferences: {},
        },
        plugins: [{ Id: 'BingWebSearch', Source: 'BuiltIn' }],
        isSbsSupported: true,
        tone: _modelTone,
        renderReferencesBehindEOS: true,
      }],
      invocationId: '0', target: 'chat', type: 4,
    }) + SIGNALR_SEP;
  }

  // ── Delta helper ─────────────────────────────────────────
  function computeDelta(oldText, newText) {
    if (!oldText) return newText;
    if (newText.indexOf(oldText) === 0) return newText.substring(oldText.length);
    if (oldText.indexOf(newText) === 0) return '';
    var commonLen = 0;
    var minLen = Math.min(newText.length, oldText.length);
    for (var ci = 0; ci < minLen; ci++) {
      if (newText[ci] === oldText[ci]) commonLen++;
      else break;
    }
    if (commonLen > 0) return newText.substring(commonLen);
    return newText;
  }

  // ── Check if message is reasoning/tool-use ───────────────
  function isReasoningMessage(msg) {
    if (!msg) return false;
    // addToChainOfThought indicates internal reasoning
    if (msg.addToChainOfThought === true) return true;
    // Code execution is part of reasoning chain
    if (msg.contentType === 'Code' || msg.contentType === 'Tool') return true;
    // Intermediate non-answer messages
    var msgType = msg.messageType || '';
    if (msgType === 'InternalLoaderMessage' || msgType === 'Progress' || msgType === 'Thinking') return true;
    // Messages with hiddenText (code/tool calls)
    if (msg.hiddenText) return true;
    return false;
  }

  // Known UI-only strings that leak into the message stream
  var UI_ARTIFACTS = ['Hide','Show','Thinking...','Reasoning...','Stop','Regenerate',
    'New topic','New chat','Try again','Continue','\u00a0','\u200b','\ufeff'];
  function isUiArtifact(text) {
    if (!text) return true;
    var t = text.trim();
    if (!t || t.length <= 1) return true;
    for (var i = 0; i < UI_ARTIFACTS.length; i++) {
      if (t === UI_ARTIFACTS[i]) return true;
    }
    return /^(Thinking|Reasoning|Stop|Show|Hide|New\s+(chat|topic|conversation))\.\.\.?$/i.test(t);
  }

  function getMessageText(msg) {
    if (!msg) return '';
    if (msg.text) return String(msg.text);
    return '';
  }

  window.__m365Send = function(text, options) {
    options = options || {};
    if (!_wsUrlTemplate) {
      _pending.push({ type: 'error', message: 'Not authenticated. Sign in to M365 first.' });
      return;
    }

    var convId = options.newConversation ? uuid() : (_currentConvId || uuid());
    var sessionId = _currentSessionId || uuid();
    var reqId = uuid();
    var isStartOfSession = !_currentConvId || options.newConversation;

    _currentConvId = convId;
    _currentSessionId = sessionId;
    _isStreaming = true;

    // Reset accumulators
    _finalBuffer = '';
    _reasoningBuffer = '';
    _reasoningEmitted = {};

    if (_currentWs && _currentWs.readyState === 1) {
      try { _currentWs.close(); } catch(e) {}
    }

    var url = buildWsUrl(convId, sessionId, reqId);
    if (!url) return;

    var ws = new _OrigWS(url);
    _currentWs = ws;
    var handshakeDone = false;

    ws.onopen = function() {
      ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + SIGNALR_SEP);
    };

    ws.onmessage = function(evt) {
      var raw = evt.data || '';
      var parts = raw.split(SIGNALR_SEP);
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i].trim();
        if (!part) continue;

        if (!handshakeDone) {
          handshakeDone = true;
          ws.send(buildChatInvoke(text, convId, sessionId, reqId, isStartOfSession));
          _pending.push({ type: 'sent', conversationId: convId });
          continue;
        }

        var msg;
        try { msg = JSON.parse(part); } catch (e) { continue; }

        var t = msg.type;
        if (t === 6) continue; // ping

        // ── type=1 streaming updates ───────────────────────
        if (t === 1 && msg.target === 'update') {
          try {
            var arg0 = msg.arguments && msg.arguments[0];
            if (!arg0) continue;

            // 1) writeAtCursor = actual answer streaming
            if (arg0.writeAtCursor && typeof arg0.writeAtCursor === 'string') {
              var newFinal = _finalBuffer + arg0.writeAtCursor;
              var delta = computeDelta(_finalBuffer, newFinal);
              if (delta) {
                _finalBuffer = newFinal;
                if (!isUiArtifact(delta)) {
                  _pending.push({ type: 'delta', text: delta, conversationId: convId });
                }
              }
            }

            // 2) messages array = reasoning/tool-use/progress
            if (arg0.messages && Array.isArray(arg0.messages) && arg0.messages.length > 0) {
              for (var mi = 0; mi < arg0.messages.length; mi++) {
                var mMsg = arg0.messages[mi];
                var mText = getMessageText(mMsg);
                if (!mText) continue;

                if (isReasoningMessage(mMsg)) {
                  // Reasoning: track per-messageId to avoid dupes
                  var mId = mMsg.messageId || '';
                  var prevReasoning = _reasoningEmitted[mId] || '';
                  var reasoningDelta = computeDelta(prevReasoning, mText);
                  if (reasoningDelta) {
                    _reasoningEmitted[mId] = mText;
                    _pending.push({
                      type: 'reasoning_delta',
                      text: reasoningDelta,
                      conversationId: convId,
                    });
                  }
                } else if (mMsg.author !== 'user') {
                  // Regular bot message — only emit NEW content not already in final buffer
                  var finalDelta = computeDelta(_finalBuffer, mText);
                  if (finalDelta) {
                    _finalBuffer = mText;
                    if (!isUiArtifact(finalDelta)) {
                      _pending.push({ type: 'delta', text: finalDelta, conversationId: convId });
                    }
                  }
                }
              }
            }
          } catch (e) {}
        }

        // ── type=2 full message ────────────────────────────
        if (t === 2) {
          var ims = (msg.item || {}).messages || [];
          for (var k = ims.length - 1; k >= 0; k--) {
            if (ims[k].author !== 'user') {
              var fullText = getMessageText(ims[k]);
              if (!fullText) continue;

              // If we already streamed most/all of it via writeAtCursor, skip
              if (_finalBuffer.length >= fullText.length || _finalBuffer.indexOf(fullText) !== -1) {
                // Already have this content, update buffer but don't emit
                if (fullText.length > _finalBuffer.length) {
                  _finalBuffer = fullText;
                }
                break;
              }

              // Partial overlap — send only what's new
              if (_finalBuffer.length > 0 && fullText.indexOf(_finalBuffer) === 0) {
                var remaining = fullText.substring(_finalBuffer.length);
                if (remaining) {
                  _pending.push({ type: 'delta', text: remaining, conversationId: convId });
                }
              } else {
                // No overlap — send full message
                _pending.push({
                  type: 'message',
                  text: fullText,
                  conversationId: convId,
                  turnState: msg.item.turnState,
                });
              }
              _finalBuffer = fullText;
              break;
            }
          }
        }

        // ── type=3 completion ───────────────────────────────
        if (t === 3) {
          _isStreaming = false;
          // Emit reasoning_done if we had any reasoning
          var hadReasoning = false;
          for (var key in _reasoningEmitted) { hadReasoning = true; break; }
          if (hadReasoning) {
            _pending.push({ type: 'reasoning_done', conversationId: convId });
          }
          _pending.push({ type: 'done', conversationId: convId });
          if (ws.readyState === 1) ws.close();
        }
      }
    };

    ws.onerror = function(err) {
      _isStreaming = false;
      _pending.push({ type: 'error', message: 'Substrate connection error', conversationId: convId });
    };

    ws.onclose = function() {
      _isStreaming = false;
    };
  };

  window.__m365Poll = function() {
    if (!_pending.length) return [];
    var batch = _pending.slice();
    _pending = [];
    return batch;
  };

  window.__m365Ready = function() {
    return !!_wsUrlTemplate;
  };

  window.__m365SetModel = function(model) {
    if (model === 'gpt-5.5-think-deeper') _modelTone = 'Gpt_5_5_Reasoning';
    else if (model === 'gpt-5.5-quick') _modelTone = 'Gpt_5_5_Chat';
    else _modelTone = 'Gpt_5_5_Reasoning';
  };

  window.__m365GetModel = function() {
    return _modelTone === 'Gpt_5_5_Reasoning' ? 'gpt-5.5-think-deeper' : 'gpt-5.5-quick';
  };

  window.__m365ClearConversation = function() {
    _currentConvId = null;
    _currentSessionId = null;
    _finalBuffer = '';
    _reasoningBuffer = '';
    _reasoningEmitted = {};
    if (_currentWs && _currentWs.readyState === 1) {
      try { _currentWs.close(); } catch(e) {}
    }
    _currentWs = null;
  };

  window.__m365IsStreaming = function() {
    return _isStreaming;
  };
})();
