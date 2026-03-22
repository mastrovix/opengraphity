interface CountBadgeProps {
  count: number
}

export function CountBadge({ count }: CountBadgeProps) {
  return (
    <span style={{
      display:         'inline-flex',
      alignItems:      'center',
      justifyContent:  'center',
      fontSize:        11,
      fontWeight:      600,
      padding:         '1px 7px',
      borderRadius:    100,
      backgroundColor: '#f1f3f8',
      color:           '#94a3b8',
      marginLeft:      6,
      verticalAlign:   'middle',
      lineHeight:      1,
    }}>
      {count}
    </span>
  )
}
