export default {
  async fetch(request: Request): Promise<Response> {
    return new Response("VeilleAnalytics API - OK");
  }
}