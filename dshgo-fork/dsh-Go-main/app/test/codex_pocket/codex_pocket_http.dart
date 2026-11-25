import 'dart:async';

import 'package:http/http.dart' as http;

class HangingHttpClient extends http.BaseClient {
  HangingHttpClient(this.handler);
  final Future<http.StreamedResponse> Function(http.BaseRequest request) handler;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) => handler(request);
}

Future<http.StreamedResponse> openSse() async =>
    http.StreamedResponse(const Stream<List<int>>.empty(), 200, headers: const {'content-type': 'text/event-stream'});
