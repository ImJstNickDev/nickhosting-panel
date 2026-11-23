const camera = `
uniform vec3 uOrigin;
uniform mat3 uAxes;
uniform vec4 uClip;
uniform float uPerspective;
uniform vec2 uDepthClip;
vec4 project(vec3 world) {
  vec3 p=uAxes*(world+uOrigin);
  if(uPerspective>0.5){
    float depth=p.z+uClip.z;
    float nearZ=uDepthClip.x,farZ=uDepthClip.y;
    // Exact endpoints avoid double-blending coplanar transparent faces on the split.
    float clipZ=depth-2.*nearZ*((farZ-depth)/(farZ-nearZ));
    return vec4(p.xy*uClip.xy*uClip.z,clipZ,depth);
  }
  return vec4(p.xy*uClip.xy,p.z/uClip.w,1.);
}
`;
const precision =
  '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp usampler2D;\n';
export const terrainVertex =
  precision +
  camera +
  `
layout(location=0) in vec2 aCorner;
uniform vec4 uTile; // width, voxel height, procedural, 2D
uniform usampler2D uData;
out vec2 uv;
out vec2 regionPosition;
uniform vec2 uMaskOffset;
float altitude(ivec2 p) {
  ivec2 last=textureSize(uData,0)-1;
  uvec4 v=texelFetch(uData,clamp(p,ivec2(0),last),0);
  if(v.a==0u) {
    for(int axis=0;axis<4;axis++){
      ivec2 d=axis==0?ivec2(-1,0):axis==1?ivec2(1,0):axis==2?ivec2(0,-1):ivec2(0,1);
      uvec4 other=texelFetch(uData,clamp(p+d,ivec2(0),last),0);
      if(other.a>0u){v=other;break;}
    }
  }
  return uTile.z>0.5?(float(v.r)-32768.)*0.1:float(v.r)*uTile.y;
}
void main(){
  uv=aCorner;
  vec2 local=aCorner*uTile.x;
  regionPosition=local+uMaskOffset;
  float y=0.;
  if(uTile.w<0.5) y=altitude(ivec2(aCorner*vec2(textureSize(uData,0))));
  gl_Position=project(vec3(local.x,y,local.y));
}
`;
export const terrainFragment =
  precision +
  `
in vec2 uv;
in vec2 regionPosition;
uniform usampler2D uData;
uniform sampler2D uPalette;
uniform sampler2D uBiomes;
uniform usampler2D uMask;
uniform vec4 uTile;
uniform vec3 uSurface; // m/s, native detail rank, biome overlay
uniform float uMaskMetres;
out vec4 outColor;
float ht(uvec4 v,float fallback){ return v.a==0u?fallback:(uTile.z>.5?(float(v.r)-32768.)*.1:float(v.r)*uTile.y); }
void main() {
  ivec2 dim=textureSize(uData,0), p=clamp(ivec2(uv*vec2(dim)),ivec2(0),dim-1);
  uvec4 v=texelFetch(uData,p,0);
  if(v.a==0u)discard;
  ivec2 mp=ivec2(floor(regionPosition/uMaskMetres)),ms=textureSize(uMask,0);
  bool inMask=all(greaterThanEqual(mp,ivec2(0)))&&all(lessThan(mp,ms));
  uint mask=inMask?texelFetch(uMask,mp,0).r:0u;
  if(uTile.z>.5){if(!inMask||(mask&16u)!=0u)discard;}
  else if((mask&15u)>uint(uSurface.y))discard;
  vec4 mat=texelFetch(uPalette,ivec2(int(v.g)&255,int(v.g)>>8),0);
  vec3 color=mat.a>0.?mat.rgb:vec3(.46,.49,.46);
  int kind=int(round(mat.a*255.));
  bool water=uTile.w>.5 ? v.b>0u : kind==2 || (v.b>0u && kind!=3);
  if(water){float d=float(v.b)*(uTile.z>.5?.1:uTile.y);color=mix(vec3(.29,.65,.69),vec3(.075,.28,.43),1.-exp(-d*.18));}
  if(uTile.z>.5&&uSurface.z>.5){vec4 biome=texelFetch(uBiomes,ivec2(int(v.a&255u),0),0);if(biome.a>0.)color=biome.rgb;}
  float h=ht(v,0.);
  float dx=ht(texelFetch(uData,min(p+ivec2(1,0),dim-1),0),h)-ht(texelFetch(uData,max(p-ivec2(1,0),ivec2(0)),0),h);
  float dz=ht(texelFetch(uData,min(p+ivec2(0,1),dim-1),0),h)-ht(texelFetch(uData,max(p-ivec2(0,1),ivec2(0)),0),h);
  vec3 norm=normalize(vec3(-dx,2.*uSurface.x,-dz));
  float shade=.68+.42*dot(norm,normalize(vec3(.55,1.,.48)));
  if(uTile.z<.5)shade+=min(.10,float(v.a&255u)*(.1/255.));
  color*=shade;
  if(uTile.z>.5)color=mix(color,vec3(dot(color,vec3(.27,.60,.13))),.46)*.90+vec3(.035,.039,.04);
  outColor=vec4(color,1.);
}
`;
export const quadVertex =
  precision +
  camera +
  `
layout(location=1) in uvec3 aMin;
layout(location=2) in uvec3 aMax;
layout(location=3) in uvec2 aFace;
uniform sampler2D uPalette;
uniform sampler2D uTextureIndex;
uniform vec2 uVoxel; // native size, translucent pass
out vec3 shadeColor;
flat out float brightness;
flat out vec2 plantStyle; // pack kind and variation per cell
out float stemHeight;
out vec2 uv;
flat out uint direction;
flat out float textureLayer;
flat out float opacity;
void main(){
  vec2 corner=vec2(float(gl_VertexID&1),float((gl_VertexID>>1)&1));
  vec3 lo=vec3(aMin)*uVoxel.x, hi=vec3(aMax)*uVoxel.x;
  direction=aFace.y;
  ivec2 at=ivec2(int(aFace.x)&255,int(aFace.x)>>8);
  vec4 m=texelFetch(uPalette,at,0);
  vec4 tex=texelFetch(uTextureIndex,at,0);
  textureLayer=tex.r-1.;
  plantStyle=vec2(0.);
  stemHeight=corner.y;
  if(direction>=8u){
    uint variation=(aMin.x*17u+aMin.z*37u+direction*11u)%29u;
    plantStyle=vec2(round(m.a*255.),float(variation)/28.);
  }
  vec3 p=lo;vec3 normal=vec3(0,1,0);
  if(direction<2u){p.zy=mix(lo.zy,hi.zy,corner);normal=vec3(direction==0u?1.:-1.,0,0);uv=p.zy;}
  else if(direction<4u){p.xz=mix(lo.xz,hi.xz,corner);normal=vec3(0,direction==2u?1.:-1.,0);uv=p.xz;}
  else if(direction<6u){p.xy=mix(lo.xy,hi.xy,corner);normal=vec3(0,0,direction==4u?1.:-1.);uv=p.xy;}
  else if(direction<8u){
    float sx=(corner.x-.5)*.7;
    p=vec3((hi.x+lo.x)*.5+sx,lo.y+corner.y*.75,(hi.z+lo.z)*.5+(direction==6u?sx:-sx));
    uv=corner;
  }else{
    p=vec3(mix(lo.x,hi.x,corner.x),mix(lo.y,hi.y,corner.y),mix(lo.z,hi.z,direction==8u?corner.x:1.-corner.x));
    uv=vec2(corner.x,corner.y*max(1.,(hi.y-lo.y)/max(uVoxel.x,tex.g)));
  }
  if(direction<6u)uv/=max(.25,tex.g);
  float diffuse=.74+.31*dot(normal,normalize(vec3(.42,1.,.58)));
  shadeColor=(m.a>0.?m.rgb:vec3(.50,.53,.49))*(tex.a>0.?tex.a:diffuse);
  brightness=tex.a>0.?tex.a:.78+.32*max(max(shadeColor.r,shadeColor.g),shadeColor.b);
  opacity=uVoxel.y>.5?(tex.b>0.?tex.b:.75):-1.;
  gl_Position=project(p);
}
`;
export const quadFragment =
  precision +
  `
precision highp sampler2DArray;
uniform sampler2DArray uTextures;
in vec3 shadeColor;flat in vec2 plantStyle;in float stemHeight;flat in float brightness;in vec2 uv;flat in uint direction;flat in float textureLayer;flat in float opacity;
out vec4 outColor;
bool grassBlade(float x,float y,float bend,float height,float width){
  float t=y/height;
  return t<1. && abs(x-(.5+bend*t*t))<width*(1.-t);
}
void main(){
  // The native aquatic cutouts tile to their edges. Shape the silhouette
  // over the complete vertical run, keeping the pack's RGB and alpha inside.
  float y=stemHeight;
  bool kelpStem=false;
  if(plantStyle.x==4.){
    float phase=plantStyle.y*6.283;
    float center=.5+.11*(sin(y*4.+phase)-sin(phase))+.05*y;
    float lobes=.5+.5*cos(y*16.+phase);
    float width=(.13+.1*lobes)*sqrt(max(0.,1.-y))*(.35+.65*smoothstep(0.,.18,y));
    float fromCenter=abs(uv.x-center);
    if(fromCenter>width)discard;
    kelpStem=fromCenter<.035*sqrt(max(0.,1.-y));
  }else if(plantStyle.x==5.){
    float lean=(plantStyle.y-.5)*.2;
    if(!grassBlade(uv.x,y,-.36+lean,.82,.075) &&
       !grassBlade(uv.x,y,.04+lean,1.,.075) &&
       !grassBlade(uv.x,y,.34+lean,.68,.065))discard;
  }
  vec4 sampleColor=vec4(shadeColor,1.);
  if(textureLayer>=0.){
    vec2 st=uv;
    if(direction>=6u)st.x=clamp(st.x,.002,.998);
    if(direction==6u||direction==7u)st.y=clamp(st.y,.002,.998);
    sampleColor=texture(uTextures,vec3(st,textureLayer));
    sampleColor.rgb*=brightness;
  }else if(direction>=6u && plantStyle.x!=4. && plantStyle.x!=5.){
    // A crossed object keeps a narrow silhouette while its pack texture streams.
    float height=fract(uv.y), width=brightness>1.1?.075:.33*(1.-height*.7);
    if(abs(uv.x-.5)>width)discard;
  }
  float alpha=1.;
  if(opacity>=0.){
    // A translucent pack texel modulates the material opacity. In particular,
    // native water has 61/255 alpha even at its most opaque texels.
    alpha=opacity*mix(1.,sampleColor.a,.4);
  }else if(sampleColor.a<.5){
    if(!kelpStem)discard;
    sampleColor.rgb=shadeColor;
  }
  outColor=vec4(sampleColor.rgb,alpha);
}
`;
export const coverageVertex =
  precision +
  camera +
  `
layout(location=1) in vec2 aCell;
uniform float uStride;
void main(){vec2 c=vec2(float(gl_VertexID&1),float((gl_VertexID>>1)&1));vec2 p=(aCell+c*uStride)*16.;gl_Position=project(vec3(p.x,0.,p.y));}
`;
export const coverageFragment =
  precision +
  `
uniform float uStride;
out vec4 outColor;
void main(){
  if(uStride>1.&&mod(floor(gl_FragCoord.x)+floor(gl_FragCoord.y),7.)>1.)discard;
  outColor=vec4(.20,.29,.28,1.);
}
`;
