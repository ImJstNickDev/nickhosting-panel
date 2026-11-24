// Openworld divides a planet into six equiangular cube faces. Each face spans 90°.
export function projectOpenworldPosition(longitude: number, latitude: number, edgeMeters: number) {
  if (
    ![longitude, latitude, edgeMeters].every(Number.isFinite) ||
    Math.abs(longitude) > 180 ||
    Math.abs(latitude) > 90 ||
    edgeMeters <= 0
  )
    return null;
  const radians = Math.PI / 180;
  const lat = latitude * radians,
    lon = longitude * radians;
  const x = Math.cos(lat) * Math.cos(lon);
  const y = Math.cos(lat) * Math.sin(lon);
  const north = Math.sin(lat);
  const normals = [x, y, -x, -y, north, -north];
  const dominant = Math.max(...normals);
  const face = normals.indexOf(dominant);
  const eastAxis = [y, -x, -y, x, x, -x][face];
  if (eastAxis === undefined) return null;
  const metres = (axis: number) => edgeMeters * (0.5 + (2 / Math.PI) * Math.atan2(axis, dominant));
  return { face, x: metres(eastAxis), z: metres(face < 4 ? north : y) };
}
